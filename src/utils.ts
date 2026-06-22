import { ADDRESS_FIELD_ORDER } from "./constants";

export function normalizeTime(time: string | undefined): string | undefined {
	if (!time) return undefined;
	const parts = time.split(":");
	if (parts.length === 2) return `${time}:00`;
	return time;
}

export function clean(obj: any): any {
	if (typeof obj !== "object" || obj === null) return obj;
	if (Array.isArray(obj))
		return obj.map(clean).filter((v) => v !== undefined && v !== null);
	return Object.entries(obj).reduce<Record<string, any>>((acc, [k, v]) => {
		if (v !== undefined && v !== null) acc[k] = clean(v);
		return acc;
	}, {});
}

export function normalizeArray(node: any): any[] {
	if (!node) return [];
	if (Array.isArray(node)) return node;
	return [node];
}

export function orderObjectByKeys<T extends object>(
	obj: T,
	orderArray: readonly string[],
): T {
	return orderArray.reduce<T>((ordered, key) => {
		if (key in obj) {
			ordered[key as keyof T] = obj[key as keyof T];
		}
		return ordered;
	}, {} as T);
}

export function toBoolean(value: unknown): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value === "true";
	return Boolean(value);
}

export function buildDateTime(
	date?: string,
	time?: string,
	timezone?: string,
): Record<string, string> | undefined {
	const obj = clean({
		date,
		time: time ? normalizeTime(time) : undefined,
		timezone,
	});
	return Object.keys(obj).length > 0 ? obj : undefined;
}

export function buildAddress(params: {
	street?: string;
	city?: string;
	state?: string;
	zip?: string;
	country?: string;
}): Record<string, string> | undefined {
	const obj = orderObjectByKeys(
		clean({
			address: params.street,
			city: params.city,
			state: params.state,
			zip: params.zip,
			country: params.country,
		}),
		ADDRESS_FIELD_ORDER,
	);
	return Object.keys(obj).length > 0 ? obj : undefined;
}

