/**
 * Receiving files from the page: the rules, and the streaming to disk.
 *
 * The page server side of `infer human upload`. The page server is a plain
 * Bun script written into a temp directory (see `ui-child.ts`), so this file
 * is embedded as text beside it and must import nothing but Node built-ins.
 * The CLI may import its types only: the bundler cannot take one file both as
 * text and as a module, so the flag parsing lives in `human/presets.ts`.
 *
 * Files are streamed to a hidden partial file in the target folder and only
 * take their real name once complete, by hard link, which fails rather than
 * overwrite. Nothing a run did not finish is left behind: a removed, refused,
 * interrupted or unsent file is deleted. See `docs/adrs/0033`.
 */

import { existsSync, linkSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { extname, join } from "node:path";

/** What the page server is told about where and what to accept. */
export interface UploadRules {
	/** Absolute folder the files land in; it already exists. */
	readonly dir: string;
	/** `accept` tokens: `.pdf`, `image/*`, `video/mp4`. Empty accepts anything. */
	readonly accept: ReadonlyArray<string>;
	readonly maxFiles?: number;
	readonly maxBytes?: number;
}

/** One file as the agent receives it. */
export interface SavedFile {
	/** Absolute path on this machine. */
	readonly path: string;
	/** The name it had on the human's device. */
	readonly name: string;
	readonly size: number;
	readonly type: string;
}

// --- rules ------------------------------------------------------------------

/**
 * Whether a file passes an accept list: an extension token matches the name,
 * a MIME token the type, `type/*` any subtype. Best effort, like the browser's
 * own: a name and a type are all there is to go on.
 */
export const acceptsFile = (
	accept: ReadonlyArray<string>,
	name: string,
	type: string,
): boolean => {
	if (accept.length === 0) return true;
	const lowerName = name.toLowerCase();
	const lowerType = (type.split(";")[0] ?? "").trim().toLowerCase();
	return accept.some((token) =>
		token.startsWith(".")
			? lowerName.endsWith(token)
			: token.endsWith("/*")
				? lowerType.startsWith(token.slice(0, -1))
				: lowerType === token,
	);
};

/** In powers of 1024, as `--max-size` reads them, so a limit reads back as set. */
export const describeSize = (bytes: number): string => {
	for (const [unit, size] of [
		["GB", 1024 ** 3],
		["MB", 1024 ** 2],
		["KB", 1024],
	] as const) {
		if (bytes >= size) {
			return `${Number((bytes / size).toFixed(1))} ${unit}`;
		}
	}
	return `${bytes} B`;
};

/**
 * A name the human's device chose, made safe to write into the folder.
 *
 * Only the last path segment survives, so `../../.ssh/x` cannot climb out;
 * separators, control and reserved characters become `_`; leading dots go, so
 * nothing is hidden and `..` cannot remain; and it is cut to 200 bytes with
 * its extension kept.
 */
export const sanitizeName = (raw: string): string => {
	const last = raw.split(/[/\\]/).pop() ?? "";
	const cleaned = last
		.normalize("NFC")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
		.replace(/^[\s.]+/, "")
		.replace(/[\s.]+$/, "");
	if (cleaned === "") return "file";
	const encoder = new TextEncoder();
	if (encoder.encode(cleaned).length <= 200) return cleaned;
	const ext = extname(cleaned).slice(0, 20);
	let stem = cleaned.slice(0, cleaned.length - ext.length);
	while (encoder.encode(stem + ext).length > 200) stem = stem.slice(0, -1);
	return stem + ext;
};

/** `name.pdf`, then `name (2).pdf`, `name (3).pdf`… until one is free. */
export const dedupeName = (
	name: string,
	taken: (candidate: string) => boolean,
): string => {
	if (!taken(name)) return name;
	const ext = extname(name);
	const stem = name.slice(0, name.length - ext.length);
	for (let n = 2; ; n++) {
		const candidate = `${stem} (${n})${ext}`;
		if (!taken(candidate)) return candidate;
	}
};

// --- receiving --------------------------------------------------------------

interface Entry {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly part: string;
	state: "writing" | "done" | "dropped";
	size: number;
	path?: string;
}

class Refused extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const refuse = (status: number, error: string): Response =>
	Response.json({ error }, { status });

/** The MIME type Bun infers from a name's extension, without parameters. */
const typeFromName = (name: string): string =>
	(Bun.file(name).type.split(";")[0] ?? "").trim();

/**
 * Links the finished partial file to a free name; a link fails rather than
 * overwrite, so a file that appeared meanwhile is never clobbered.
 */
const settle = (dir: string, part: string, name: string): string => {
	const tried = new Set<string>();
	for (;;) {
		const candidate = dedupeName(
			name,
			(c) => tried.has(c) || existsSync(join(dir, c)),
		);
		const path = join(dir, candidate);
		try {
			linkSync(part, path);
			rmSync(part, { force: true });
			return path;
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "EEXIST") {
				tried.add(candidate);
				continue;
			}
			// No hard links on this filesystem: a checked rename instead.
			renameSync(part, path);
			return path;
		}
	}
};

export interface Uploads {
	/** Streams one `POST /api/upload` to disk; answers with the saved file. */
	readonly receive: (request: Request) => Promise<Response>;
	/** Deletes a file, finished or not. */
	readonly remove: (id: string) => boolean;
	/** Keeps the finished files named, in that order, and deletes the rest. */
	readonly keep: (ids: ReadonlyArray<string> | undefined) => Array<SavedFile>;
	/** Deletes everything, synchronously, for exits and signals. */
	readonly discard: () => void;
}

export const createUploads = (rules: UploadRules): Uploads => {
	const entries = new Map<string, Entry>();

	const drop = (entry: Entry): void => {
		entry.state = "dropped";
		entries.delete(entry.id);
		rmSync(entry.part, { force: true });
		if (entry.path) rmSync(entry.path, { force: true });
	};

	const receive = async (request: Request): Promise<Response> => {
		const name = (() => {
			try {
				return decodeURIComponent(request.headers.get("x-infer-name") ?? "");
			} catch {
				return "";
			}
		})();
		const type =
			(request.headers.get("x-infer-type") ?? "").trim() ||
			typeFromName(name) ||
			"application/octet-stream";
		const shown = name || "file";
		if (rules.maxFiles !== undefined && entries.size >= rules.maxFiles) {
			return refuse(
				409,
				`At most ${rules.maxFiles} file${rules.maxFiles === 1 ? "" : "s"}.`,
			);
		}
		if (
			!acceptsFile(rules.accept, name, type) &&
			!acceptsFile(rules.accept, name, typeFromName(name))
		) {
			return refuse(
				415,
				`${shown} is not an accepted type (${rules.accept.join(", ")}).`,
			);
		}
		const length = Number(request.headers.get("content-length") ?? Number.NaN);
		if (rules.maxBytes !== undefined && length > rules.maxBytes) {
			return refuse(
				413,
				`${shown} is ${describeSize(length)}, over the ${describeSize(rules.maxBytes)} limit.`,
			);
		}
		if (!request.body) return refuse(400, "No file in the request.");

		const id = crypto.randomUUID();
		const entry: Entry = {
			id,
			name: name || "file",
			type,
			part: join(rules.dir, `.infer-upload-${id}.part`),
			state: "writing",
			size: 0,
		};
		entries.set(id, entry);
		const handle = await open(entry.part, "wx");
		try {
			// One chunk at a time, each written before the next is read, so memory
			// stays flat however large the file is.
			for await (const chunk of request.body) {
				if (entry.state !== "writing") throw new Refused(410, "Removed.");
				entry.size += chunk.byteLength;
				if (rules.maxBytes !== undefined && entry.size > rules.maxBytes) {
					throw new Refused(
						413,
						`${shown} is over the ${describeSize(rules.maxBytes)} limit.`,
					);
				}
				await handle.write(chunk);
			}
			await handle.close();
			if (entry.state !== "writing") throw new Refused(410, "Removed.");
			entry.path = settle(rules.dir, entry.part, sanitizeName(entry.name));
			entry.state = "done";
			return Response.json({
				id,
				name: entry.name,
				size: entry.size,
				type,
			});
		} catch (error) {
			await handle.close().catch(() => {});
			drop(entry);
			return error instanceof Refused
				? refuse(error.status, error.message)
				: refuse(400, `${shown} did not arrive whole.`);
		}
	};

	const remove = (id: string): boolean => {
		const entry = entries.get(id);
		if (!entry) return false;
		drop(entry);
		return true;
	};

	const keep = (ids: ReadonlyArray<string> | undefined): Array<SavedFile> => {
		const order = ids ?? [...entries.keys()];
		const kept: Array<SavedFile> = [];
		for (const id of order) {
			const entry = entries.get(id);
			if (entry?.state === "done" && entry.path) {
				kept.push({
					path: entry.path,
					name: entry.name,
					size: entry.size,
					type: entry.type,
				});
			}
		}
		const keptIds = new Set(
			order.filter((id) => entries.get(id)?.state === "done"),
		);
		for (const entry of [...entries.values()]) {
			if (keptIds.has(entry.id)) continue;
			drop(entry);
		}
		for (const id of keptIds) entries.delete(id);
		return kept;
	};

	const discard = (): void => {
		for (const entry of [...entries.values()]) drop(entry);
	};

	return { receive, remove, keep, discard };
};
