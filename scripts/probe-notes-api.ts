import { TripIt } from "../src/tripit";

function requiredEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing env var: ${name}`);
	return v;
}

const client = new TripIt({
	username: requiredEnv("TRIPIT_USERNAME"),
	password: requiredEnv("TRIPIT_PASSWORD"),
});
const token = await client.authenticate();

const TRIP_UUID = "f1790b02-4400-9000-0001-000016abc4dd";
// Restaurant the user just updated via web UI
const EXISTING_UUID = "b383e3ef-7e50-9000-0004-000052ed9559";

async function call(method: "GET" | "POST", url: string, body?: object) {
	process.stdout.write(`\n=== ${method} ${url}\n`);
	if (body) process.stdout.write(`payload: ${JSON.stringify(body)}\n`);
	const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
	if (body) {
		(init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
		init.body = new URLSearchParams({ json: JSON.stringify(body) }).toString();
	}
	const res = await fetch(url, init);
	const text = await res.text();
	process.stdout.write(`status: ${res.status}\n`);
	const preview = text.length > 900 ? `${text.slice(0, 900)}\n...[${text.length} bytes]` : text;
	process.stdout.write(`body: ${preview}\n`);
	return { status: res.status, text };
}

// 0. First, GET the existing restaurant to see what api.tripit.com returns for DateTime
await call(
	"GET",
	`https://api.tripit.com/v2/get/restaurant/uuid/${EXISTING_UUID}/format/json`,
);

// 1. Create with DateTime singular on api.tripit.com
const createdUuids: string[] = [];
const variants: Array<{ label: string; payload: Record<string, unknown> }> = [
	{
		label: "create + DateTime singular",
		payload: {
			RestaurantObject: {
				trip_uuid: TRIP_UUID,
				display_name: "Probe DT v1",
				supplier_name: "Probe DT v1",
				DateTime: {
					date: "2026-06-27",
					time: "17:00:00",
					timezone: "America/New_York",
				},
			},
		},
	},
	{
		label: "create + DateTime + Agency + Address (mirror web payload)",
		payload: {
			RestaurantObject: {
				trip_uuid: TRIP_UUID,
				display_name: "Probe DT v2",
				supplier_name: "Probe DT v2",
				is_purchased: "true",
				Agency: {},
				DateTime: {
					date: "2026-06-27",
					time: "17:00:00",
					timezone: "America/New_York",
					is_timezone_manual: "false",
				},
				Address: {},
			},
		},
	},
];

for (const v of variants) {
	process.stdout.write(`\n--- VARIANT: ${v.label}\n`);
	const res = await call(
		"POST",
		"https://api.tripit.com/v2/create/restaurant/format/json",
		v.payload,
	);
	if (res.status === 200) {
		try {
			const parsed = JSON.parse(res.text) as { RestaurantObject?: { uuid?: string } };
			if (parsed.RestaurantObject?.uuid) createdUuids.push(parsed.RestaurantObject.uuid);
		} catch {}
	}
}

// 2. Try replacePlan/restaurant on api.tripit.com — maybe it exists there too
await call(
	"POST",
	`https://api.tripit.com/v2/replacePlan/restaurant/uuid/${EXISTING_UUID}/format/json`,
	{
		RestaurantObject: {
			trip_uuid: TRIP_UUID,
			display_name: "The Grey",
			supplier_name: "The Grey",
			DateTime: {
				date: "2026-06-27",
				time: "17:00:00",
				timezone: "America/New_York",
			},
		},
	},
);

// 3. Try replace/restaurant on api.tripit.com with DateTime singular
await call(
	"POST",
	`https://api.tripit.com/v2/replace/restaurant/uuid/${EXISTING_UUID}/format/json`,
	{
		RestaurantObject: {
			trip_uuid: TRIP_UUID,
			display_name: "The Grey",
			supplier_name: "The Grey",
			is_purchased: "true",
			DateTime: {
				date: "2026-06-27",
				time: "17:00:00",
				timezone: "America/New_York",
			},
		},
	},
);

// Cleanup probes
for (const u of createdUuids) {
	await call("GET", `https://api.tripit.com/v2/delete/restaurant/uuid/${u}/format/json`);
}
