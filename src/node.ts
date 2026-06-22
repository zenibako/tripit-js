import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TripIt, type ImageAttachment } from "./tripit";
import type { CachedToken, TokenStore, TripItConfig } from "./types";

const CACHE_DIR = join(homedir(), ".config", "tripit");
const TOKEN_CACHE_FILE = join(CACHE_DIR, "token.json");

export class FsTokenStore implements TokenStore {
	private readonly cacheFile: string;

	constructor(cacheFile: string = TOKEN_CACHE_FILE) {
		this.cacheFile = cacheFile;
	}

	async load(): Promise<CachedToken | null> {
		try {
			if (existsSync(this.cacheFile)) {
				return JSON.parse(readFileSync(this.cacheFile, "utf-8"));
			}
		} catch {
			// Ignore corrupt cache
		}
		return null;
	}

	async save(token: CachedToken): Promise<void> {
		const dir = this.cacheFile.substring(0, this.cacheFile.lastIndexOf("/"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(this.cacheFile, JSON.stringify(token, null, 2));
	}
}

function mimeTypeForPath(filePath: string): string | undefined {
	switch (extname(filePath).toLowerCase()) {
		case ".pdf":
			return "application/pdf";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		default:
			return undefined;
	}
}

export class TripItNode extends TripIt {
	constructor(config: TripItConfig) {
		super({ ...config, tokenStore: config.tokenStore ?? new FsTokenStore() });
	}

	async attachDocumentFromPath(params: {
		objectType?: "lodging" | "activity" | "air" | "transport";
		objectId: string;
		filePath: string;
		caption?: string;
		mimeType?: string;
	}) {
		try {
			await access(params.filePath);
		} catch {
			throw new Error(`File not found: ${params.filePath}`);
		}

		const buffer = await readFile(params.filePath);
		const mimeType =
			params.mimeType || mimeTypeForPath(params.filePath) || "application/pdf";
		const caption =
			params.caption || params.filePath.split("/").pop() || "document";

		const attachment: ImageAttachment = {
			content: new Uint8Array(buffer),
			mimeType,
			caption,
		};

		return this.attachDocument({
			objectType: params.objectType,
			objectId: params.objectId,
			attachment,
		});
	}
}

export { FsTokenStore as default };