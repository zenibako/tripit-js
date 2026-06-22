# RFC: Unfiled Notes Support for tripit-js CLI

**Status:** Draft  
**Date:** 2026-05-27  
**Author:** chanderson  
**Related:** tripsync skill HAR analysis, Savannah note conversion workflow

---

## 1. Problem Statement

TripIt receives forwarded emails (Resy, OpenTable, airline confirmations, etc.) as **unfiled notes** rather than parsed plans. The current `tripit` CLI provides no way to:

1. **List** unfiled notes
2. **Read** a note's full text
3. **Delete** a note
4. **Convert** a note into a typed trip plan (RestaurantObject, FlightObject, etc.)

Web UI analysis (HAR capture) shows that TripIt exposes note APIs on `www.tripit.com` using **cookie-based session auth**, while the CLI only supports `api.tripit.com` with **Bearer token auth**. The two auth domains are independent and cannot be used interchangeably.

---

## 2. Goals

1. Enable the CLI to **discover, read, and delete** unfiled notes
2. Enable the CLI to **convert** a note into any typed plan (Restaurant, Flight, Hotel, Transport, Activity)
3. Enable the CLI to **backfill** typed plans with structured data (dates, times, addresses, notes)
4. Maintain backward compatibility with existing `api.tripit.com` workflows
5. Preserve the web UI's atomic conversion semantics (create typed plan + delete note in one operation)

---

## 3. Architecture: Dual Auth Domains

TripIt maintains two independent authentication domains:

| Domain | Auth | Endpoints | Use Case |
|--------|------|-----------|----------|
| `api.tripit.com` | Bearer token (OAuth2) | Trips, plans (CRUD), images | CLI primary workflow |
| `www.tripit.com` | Session cookie (OAuth2 → web session) | Notes, autocomplete, form-based create/delete | Web UI + note conversion |

**Key constraint:** The Bearer token from `api.tripit.com` returns **401** on `www.tripit.com` endpoints. The web session cookie is established during the OAuth2 redirect dance and is NOT the same as the Bearer token.

### 3.1 Auth Flow Discovery

The existing `auth.ts` already uses `fetch-cookie` + `tough-cookie` for the OAuth2 redirect dance. After login, the cookie jar contains session cookies for `www.tripit.com` (`.tripit.com` domain scope). The token exchange returns a Bearer token for `api.tripit.com`. **Both are available after `authenticate()`.**

**Proposal:** Store the cookie jar alongside the cached token, and expose a `webApiGet`/`webApiPost` method that uses the cookie jar instead of the Bearer token.

---

## 4. Proposed Changes

### 4.1 Library (`src/tripit.ts`)

#### 4.1.1 Cookie Jar Persistence

```ts
// Add to CACHE_DIR
export const COOKIE_CACHE_FILE = path.join(CACHE_DIR, "cookies.json");

// In TripIt class:
private cookieJar: CookieJar | null = null;

async authenticate(): Promise<string> {
  this.accessToken = await authenticate(this.config);
  // cookieJar is populated by authenticate() via fetch-cookie
  this.cookieJar = /* get from auth flow */;
  return this.accessToken;
}

// Persist cookies
private persistCookies(): void {
  if (this.cookieJar) {
    fs.writeFileSync(COOKIE_CACHE_FILE, JSON.stringify(this.cookieJar.toJSON()));
  }
}

// Load cookies
private loadCookies(): CookieJar | null {
  if (fs.existsSync(COOKIE_CACHE_FILE)) {
    const jar = new CookieJar();
    const data = JSON.parse(fs.readFileSync(COOKIE_CACHE_FILE, "utf-8"));
    // Restore cookies
    return jar;
  }
  return null;
}
```

#### 4.1.2 Web API Helpers

```ts
private async webApiGet<TResponse>(path: string): Promise<TResponse> {
  if (!this.cookieJar) throw new Error("No web session. Run authenticate() first.");
  const fetchWithCookie = fetchCookie(fetch, this.cookieJar);
  const res = await fetchWithCookie(`${BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-TRIPIT-APP-INFO": "web/0.0.2",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Web API error (${res.status}): ${text}`);
  return JSON.parse(text) as TResponse;
}

private async webApiPost<TResponse>(path: string, payload?: unknown): Promise<TResponse> {
  // Similar pattern with CSRF token extraction
}
```

**CSRF Challenge:** The web API requires `X-CSRF-Token-WA` header. This is returned in a `Set-Cookie` (`it_wa_csrf=...`) on every API response. The client must extract this cookie value and include it in subsequent POST requests.

#### 4.1.3 Note Methods

```ts
// List unfiled notes
async listNotes(options?: { pageSize?: number; pageNum?: number }): Promise<NoteListResponse> {
  const params = new URLSearchParams({
    exclude_types: "weather",
    page_size: String(options?.pageSize ?? 25),
    page_num: String(options?.pageNum ?? 1),
    is_unfiled_items_only: "true",
  });
  return this.webApiGet(`/api/v2/list/object?${params}`);
}

// Get a single note
async getNote(uuid: string): Promise<NoteResponse> {
  return this.webApiGet(`/api/v2/get/note/uuid/${uuid}`);
}

// Delete a note
async deleteNote(uuid: string): Promise<DeleteResponse> {
  return this.webApiPost(`/api/v2/delete/note/uuid/${uuid}`);
}
```

#### 4.1.4 Typed Plan Creation (Web API)

```ts
// Create a type-specific plan from parsed data
async createRestaurant(params: RestaurantCreateParams): Promise<RestaurantResponse> {
  const payload = orderObjectByKeys({
    RestaurantObject: clean({
      trip_uuid: params.tripId,
      display_name: params.displayName,
      supplier_name: params.supplierName,
      notes: params.notes,
      // ... XSD-ordered fields
    }),
  }, ...);
  return this.webApiPost("/api/v2/create", payload);
}

// Similar for createFlight, createLodging, createTransport, createActivity
```

**XSD Validation Constraint:** The web API `POST /api/v2/create` validates JSON against an XSD schema. Field order matters for `xs:sequence` types. The existing `orderObjectByKeys` utility should be reused.

**Known Limitation:** `RestaurantObject` with `DateTime` and `Address` children fails XSD validation on the public API (confirmed via testing). These fields should be parsed into structured notes text rather than nested objects, or the user should fill them in the web UI later.

### 4.2 Types (`src/types.ts`)

Add:

```ts
export interface NoteObject {
  id: string;
  uuid: string;
  relative_url?: string;
  display_name: string;
  is_display_name_auto_generated?: string;
  last_modified?: string;
  text: string;
}

export interface NoteListResponse extends ApiMetadata {
  NoteObject?: OneOrMany<NoteObject>;
  RestaurantObject?: OneOrMany<RestaurantObject>; // Included when is_unfiled_items_only=false
  // ... other plan types
  page_num?: string;
  page_size?: string;
  max_page?: string;
  total_items?: string;
}

export interface NoteResponse extends ApiMetadata {
  NoteObject: NoteObject;
}

export interface RestaurantObject {
  // Already partially defined; extend with restaurant-specific fields
  supplier_name?: string;
  is_purchased?: string;
  is_tripit_booking?: string;
  is_concur_booked?: string;
}

// ... add FlightObject, HotelObject (LodgingObject already exists)
```

### 4.3 CLI Commands (`index.ts`)

#### `tripit notes` subcommand

```
tripit notes list                    # List unfiled notes
  [--page-size <n>]                  # Default 25
  [--page-num <n>]                   # Default 1
  [-o, --output <format>]           # text or json

tripit notes get <uuid>              # Read a note's full text
  [-o, --output <format>]

tripit notes delete <uuid>           # Delete a note
  [-o, --output <format>]
```

#### `tripit notes convert` subcommand

```
tripit notes convert <note-uuid> <type> <trip-uuid>
  [--name <display_name>]
  [--supplier <supplier_name>]
  [--notes <custom_notes>]
  [--dry-run]                        # Preview, don't execute
  [-o, --output <format>]

type: restaurant | flight | hotel | transport | activity
```

**Behavior:**
1. Fetch the note text via `GET /api/v2/get/note/uuid/<uuid>`
2. Parse the text for structured data (venue name, address, date, time, confirmation numbers) — can use a simple regex heuristic or accept manual overrides via flags
3. Call `POST /api/v2/create` with the appropriate typed object (e.g., `RestaurantObject`)
4. Call `POST /api/v2/delete/note/uuid/<uuid>` to delete the original note
5. Return the newly created plan UUID

**Fallback:** If parsing fails or the user wants manual control, print the note text and prompt for field values (interactive mode) or require explicit flags.

#### Example Session

```bash
$ tripit notes list
Unfiled Notes (2):
  525cca59-2560-9000-0003-0001443101fd  Fwd: Your reservation at The Grey Restaurant is confirmed
  ddff5092-6765-9000-0003-00013e7946e5  (No Subject)

$ tripit notes get 525cca59-2560-9000-0003-0001443101fd
---
From: Shadwa Mussad (via Resy)
Date: Wed, May 27, 2026 at 11:22 AM
Subject: Your reservation at The Grey Restaurant is confirmed
...
The Grey Restaurant
109 Martin Luther King Jr Blvd
Savannah, GA 31401
Sat, Jun. 27 at 5:00pm
3 Guests, Dining Room

$ tripit notes convert 525cca59-2560-9000-0003-0001443101fd restaurant f1790b02-4400-9000-0001-000016abc4dd
Converted note to RestaurantObject:
  UUID: b383e3ef-7e50-9000-0004-000052ed9559
  Trip: Savannah, GA, June 2026
  Name: The Grey
  Original note deleted.
```

### 4.4 Constants (`src/constants.ts`)

Add field order constants for type-specific objects that the web API expects:

```ts
export const RESTAURANT_FIELD_ORDER = [
  "uuid",
  "trip_id",
  "trip_uuid",
  "is_client_traveler",
  "display_name",
  "Image",
  "booking_rate",
  "supplier_conf_num",
  "supplier_name",
  "is_purchased",
  "notes",
  "total_cost",
  "is_tripit_booking",
  "is_concur_booked",
  // DateTime and Address omitted — they fail XSD validation on RestaurantObject
] as const;

export const NOTE_FIELD_ORDER = [
  "id",
  "uuid",
  "relative_url",
  "display_name",
  "is_display_name_auto_generated",
  "last_modified",
  "text",
] as const;
```

---

## 5. Implementation Plan

### Phase 1: Web Session Auth
1. Modify `auth.ts` to persist the `CookieJar` after the OAuth2 flow completes
2. Add `COOKIE_CACHE_FILE` constant
3. Add `webApiGet`/`webApiPost` helpers to `TripIt` class
4. Implement CSRF token extraction from `it_wa_csrf` cookie
5. Add retry logic: if cookie session is expired (401), re-run `authenticate()`

### Phase 2: Note CRUD
1. Add `NoteObject` types to `src/types.ts`
2. Add `listNotes`, `getNote`, `deleteNote` to `TripIt` class
3. Add `notes list`, `notes get`, `notes delete` CLI commands
4. Add tests with mock HAR data

### Phase 3: Note-to-Plan Conversion
1. Add `createRestaurant`, `createFlight`, `createLodging`, `createTransport`, `createActivity` web API methods
2. Add a note text parser (regex-based for common formats: Resy, OpenTable, airline confirmations)
3. Add `notes convert` CLI command with type-specific subcommands
4. Add `--dry-run` flag for preview
5. Add tests

### Phase 4: Integration & Polish
1. Update README with new commands
2. Update `tripsync` skill to reference the new CLI capabilities
3. Add error handling for edge cases (expired cookies, missing CSRF, parse failures)
4. Performance: cache note list locally to avoid repeated API calls

---

## 6. Open Questions

1. **CSRF Refresh:** Does `it_wa_csrf` rotate on every request or only on auth events? The HAR shows it changes between requests. We need to handle dynamic CSRF extraction.
2. **RestaurantObject DateTime/Address:** These fields fail XSD validation on the public API. Is there a different endpoint (`/api/v2/replace/restaurant/...`?) that accepts them, or should we stick to structured notes?
3. **Parse Heuristics:** Resy emails have a predictable format, but OpenTable, airline confirmations, and generic forwards vary widely. Should we use a pluggable parser system or simple regex?
4. **Session Expiry:** How long does the web session cookie last? Should we implement automatic re-auth when the cookie expires?

---

## 7. Testing Strategy

1. **Unit tests:** Mock web API responses using HAR data fixtures
2. **Integration tests:** Run against live TripIt account with a test note
3. **Auth tests:** Verify cookie jar persistence and re-auth on expiry
4. **XSD tests:** Verify field ordering for each type-specific create payload

---

## 8. Dependencies

No new dependencies required. The repo already includes:
- `fetch-cookie` — for cookie-aware fetch
- `tough-cookie` — for cookie jar management
- `cheerio` — for HTML parsing (can be reused for email text parsing)

---

## 9. Backward Compatibility

All existing `api.tripit.com` methods remain unchanged. The new web API methods are additive and use separate `webApi*` helpers. The CLI gains new subcommands (`notes`, `notes convert`) without modifying existing commands.

---

## 10. Acceptance Criteria

- [ ] `tripit notes list` returns unfiled notes with UUID and display_name
- [ ] `tripit notes get <uuid>` returns the full note text
- [ ] `tripit notes delete <uuid>` removes the note and returns confirmation
- [ ] `tripit notes convert <uuid> restaurant <trip-uuid>` creates a RestaurantObject and deletes the note
- [ ] The created RestaurantObject is discoverable via `tripit trips get <trip-uuid>`
- [ ] Cookie session persists across CLI invocations (stored in `~/.config/tripit/`)
- [ ] Session auto-refreshes when cookies expire
- [ ] All new commands support `-o json` output format
- [ ] The tripsync skill documentation is updated to reference the new CLI commands
