import {
	API_BASE_URL,
	BASE_URL,
	BROWSER_HEADERS,
	DEFAULT_CLIENT_ID,
	REDIRECT_URI,
	SCOPES,
} from "./constants";
import type { CachedToken, TokenStore, TripItConfig } from "./types";

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function randomBytesHex(length: number): Promise<string> {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return base64UrlEncode(new Uint8Array(hash));
}

function parseSetCookieHeaders(setCookieHeaders: string[]): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const header of setCookieHeaders) {
		const match = header.match(/^([^=]+)=([^;]*)/);
		if (match && match[1] && match[2]) cookies[match[1].trim()] = match[2].trim();
	}
	return cookies;
}

function cookieHeader(cookies: Record<string, string>): string {
	return Object.entries(cookies)
		.map(([k, v]) => `${k}=${v}`)
		.join("; ");
}

function extractFormInputs(html: string): Record<string, string> {
	const inputs: Record<string, string> = {};
	const inputRegex = /<input[^>]+name=["']([^"']+)["'](?:[^>]*value=["']([^"']*)["'])?/gi;
	let match: RegExpExecArray | null;
	while ((match = inputRegex.exec(html)) !== null) {
		if (match[1]) inputs[match[1]] = match[2] ?? "";
	}
	return inputs;
}

function extractFormAction(html: string): string | null {
	const match = html.match(/<form[^>]+action=["']([^"']+)["']/i);
	return match && match[1] ? match[1] : null;
}

function extractErrorFromHtml(html: string): string {
	const errorMatch = html.match(/class=["']error-message["'][^>]*>([^<]+)/i)
		|| html.match(/class=["']alert-error["'][^>]*>([^<]+)/i);
	return errorMatch && errorMatch[1] ? errorMatch[1].trim() : "";
}

function extractRedirectFromHtml(html: string): string | null {
	const metaMatch = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'].*?URL=(.+?)["']/i);
	if (metaMatch && metaMatch[1]) return metaMatch[1];
	const scriptMatch = html.match(/(?:window\.location|window\.location\.href)\s*=\s*["']([^"']+)["']/);
	if (scriptMatch && scriptMatch[1]) return scriptMatch[1];
	return null;
}

async function followRedirects(
	url: string,
	cookies: Record<string, string>,
): Promise<{ html: string; formAction: string; cookies: Record<string, string> }> {
	let currentUrl = url;
	for (let i = 0; i < 5; i++) {
		const headers: Record<string, string> = {
			...BROWSER_HEADERS,
			Cookie: cookieHeader(cookies),
		};
		const res = await fetch(currentUrl, { headers, redirect: "manual" });
		const body = await res.text();

		const setCookies = res.headers.getSetCookie?.() ?? [];
		Object.assign(cookies, parseSetCookieHeaders(setCookies));

		if (res.status === 302 || res.status === 303) {
			const location = res.headers.get("location");
			if (!location) throw new Error("Redirect without location header");
			currentUrl = new URL(location, currentUrl).href;
			continue;
		}

		if (!body.includes('name="username"') || !body.includes('name="password"')) {
			throw new Error("Login form not found");
		}

		return { html: body, formAction: currentUrl, cookies };
	}
	throw new Error("Too many redirects while getting login form");
}

async function submitLogin(
	config: TripItConfig,
	formHtml: string,
	formAction: string,
	cookies: Record<string, string>,
): Promise<string> {
	const submitData = extractFormInputs(formHtml);
	submitData.username = config.username;
	submitData.password = config.password;

	const formActionUrl = extractFormAction(formHtml);
	if (!formActionUrl) throw new Error("No form action URL found");
	const finalUrl = new URL(formActionUrl, formAction).href;

	const headers: Record<string, string> = {
		...BROWSER_HEADERS,
		"Content-Type": "application/x-www-form-urlencoded",
		"Sec-Fetch-Site": "same-origin",
		"Sec-Fetch-User": "?1",
		Origin: BASE_URL,
		Referer: formAction,
		Cookie: cookieHeader(cookies),
	};

	const res = await fetch(finalUrl, {
		method: "POST",
		headers,
		body: new URLSearchParams(submitData).toString(),
		redirect: "manual",
	});

	const setCookies = res.headers.getSetCookie?.() ?? [];
	Object.assign(cookies, parseSetCookieHeaders(setCookies));

	const responseText = await res.text();

	if (res.status === 403) throw new Error("Login failed (403)");

	if (res.status === 302 || res.status === 303) {
		const location = res.headers.get("location");
		if (!location) throw new Error("No redirect location after login");
		return location;
	}

	if (res.status === 200) {
		const errorMsg = extractErrorFromHtml(responseText);
		if (errorMsg) throw new Error(`Login failed: ${errorMsg}`);
		const redirect = extractRedirectFromHtml(responseText);
		if (redirect) return redirect;
		throw new Error("Could not find redirect URL in login response");
	}

	throw new Error(`Unexpected login response status: ${res.status}`);
}

async function exchangeCodeForToken(
	config: TripItConfig,
	code: string,
	codeVerifier: string,
): Promise<CachedToken> {
	const clientId = config.clientId ?? DEFAULT_CLIENT_ID;
	const params = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		client_id: clientId,
		code_verifier: codeVerifier,
	});

	const res = await fetch(`${API_BASE_URL}/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Token exchange failed (${res.status}): ${body}`);
	}

	const tokenResponse = await res.json() as {
		access_token: string;
		expires_in: number;
		token_type: string;
		scope: string;
	};

	return {
		access_token: tokenResponse.access_token,
		expires_in: tokenResponse.expires_in,
		token_type: tokenResponse.token_type,
		scope: tokenResponse.scope,
		expiresAt: Date.now() + (tokenResponse.expires_in - 30) * 1000,
	};
}

export async function authenticate(config: TripItConfig): Promise<string> {
	const clientId = config.clientId ?? DEFAULT_CLIENT_ID;

	if (config.tokenStore) {
		const cached = await config.tokenStore.load();
		if (cached && cached.expiresAt > Date.now()) return cached.access_token;
	}

	const codeVerifier = await randomBytesHex(32);
	const codeChallenge = await sha256Base64Url(codeVerifier);
	const state = await randomBytesHex(16);

	const authUrl =
		`${BASE_URL}/auth/oauth2/authorize?` +
		`client_id=${encodeURIComponent(clientId)}` +
		`&response_type=code` +
		`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
		`&scope=${encodeURIComponent(SCOPES)}` +
		`&state=${encodeURIComponent(state)}` +
		`&code_challenge=${encodeURIComponent(codeChallenge)}` +
		`&code_challenge_method=S256` +
		`&response_mode=query` +
		`&action=sign_in`;

	const cookies: Record<string, string> = {};
	const { html, formAction } = await followRedirects(authUrl, cookies);
	const redirectUrl = await submitLogin(config, html, formAction, cookies);

	const parsedUrl = new URL(redirectUrl, "http://localhost");
	const returnedState = parsedUrl.searchParams.get("state");
	if (returnedState !== state) throw new Error("OAuth state mismatch");

	const code = parsedUrl.searchParams.get("code");
	if (!code) throw new Error("Authorization code not found in redirect");

	const token = await exchangeCodeForToken(config, code, codeVerifier);
	if (!token.access_token) throw new Error("No access_token in response");

	if (config.tokenStore) await config.tokenStore.save(token);

	return token.access_token;
}