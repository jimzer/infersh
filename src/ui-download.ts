/**
 * Handing files to the page: the rules, and the streaming from disk.
 *
 * The page server side of `infer human download`. Like `ui-upload.ts`, this
 * file is embedded as text and written beside the page server, so it imports
 * nothing but Node built-ins and its neighbours; the CLI imports its types
 * only.
 *
 * Only the files named on the command line are reachable, by their position
 * in that list — never by a path, so there is nothing to traverse. Each is
 * streamed from disk, with HTTP Range support for resuming a download and
 * seeking a video. A file counts as downloaded once every byte of it has been
 * handed to a download request, across however many requests that took, or
 * once a Download all archive holding it has been sent whole. A preview never
 * counts: a video played in the page is not a file saved. See
 * `docs/adrs/0034`.
 */

import { statSync } from "node:fs";
import { planZip, writeZip, zipNames } from "./ui-zip.ts";

/** One file the agent offers, as the page server is told about it. */
export interface OfferedFile {
	/** Absolute path on this machine. */
	readonly path: string;
	/** The name the human sees, and saves it under. */
	readonly name: string;
	readonly size: number;
	/** The MIME type, from the extension. */
	readonly type: string;
}

export interface DownloadRules {
	readonly files: ReadonlyArray<OfferedFile>;
	/** What Download all saves the archive as. */
	readonly zipName: string;
}

/** One file the human downloaded, as the agent is told. */
export interface DownloadedFile {
	readonly path: string;
	readonly name: string;
	readonly size: number;
}

// --- rules ------------------------------------------------------------------

/**
 * A `Content-Disposition` that survives any file name: a plain ASCII
 * `filename` for old clients, and the exact name as UTF-8 in `filename*`
 * (RFC 6266 and 5987), which every current browser prefers.
 */
export const contentDisposition = (
	kind: "attachment" | "inline",
	name: string,
): string => {
	const fallback =
		name
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file";
	// encodeURIComponent leaves ' ( ) * as they are; RFC 5987 does not allow them.
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/** What a `Range` header asks of a file of a given size. */
export type RangeRequest =
	| { readonly kind: "full" }
	| { readonly kind: "partial"; readonly start: number; readonly end: number }
	| { readonly kind: "unsatisfiable" };

/**
 * Reads a `Range` header against a file's size (RFC 9110 §14). `end` is
 * inclusive, as the header has it.
 *
 * A header that is malformed, or not about bytes, is ignored and the whole
 * file is sent, which the RFC allows. So is a request for several ranges:
 * browsers and download tools ask for one, and a multipart answer is a lot of
 * machinery for nobody. A range that starts past the end cannot be met: 416.
 */
export const parseRange = (
	header: string | null,
	size: number,
): RangeRequest => {
	const full = { kind: "full" } as const;
	const unsatisfiable = { kind: "unsatisfiable" } as const;
	if (header === null) return full;
	const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
	if (!match) return full;
	const [, first = "", last = ""] = match;
	if (first === "") {
		// A suffix: the last n bytes.
		if (last === "") return full;
		const length = Number(last);
		if (length === 0 || size === 0) return unsatisfiable;
		return {
			kind: "partial",
			start: Math.max(0, size - length),
			end: size - 1,
		};
	}
	const start = Number(first);
	const end = last === "" ? size - 1 : Number(last);
	if (last !== "" && end < start) return full;
	if (start >= size) return unsatisfiable;
	return { kind: "partial", start, end: Math.min(end, size - 1) };
};

/** Byte spans already sent, half open and merged: `[[0, 100], [200, 300]]`. */
export type Spans = ReadonlyArray<readonly [number, number]>;

/** Adds `[start, end)` to a set of spans, merging what touches. */
export const addSpan = (spans: Spans, start: number, end: number): Spans => {
	if (end <= start) return spans;
	const merged: Array<readonly [number, number]> = [];
	let current: [number, number] = [start, end];
	for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
		if (span[1] < current[0] || span[0] > current[1]) {
			merged.push(span);
		} else {
			current = [Math.min(span[0], current[0]), Math.max(span[1], current[1])];
		}
	}
	merged.push(current);
	return merged.sort((a, b) => a[0] - b[0]);
};

/** Whether the spans cover every byte of a file this size. */
export const covers = (spans: Spans, size: number): boolean =>
	size === 0 || spans.some(([start, end]) => start <= 0 && end >= size);

/** What the page shows inline rather than only offering to save. */
export const previewable = (type: string): boolean =>
	/^(image|video|audio)\//.test(type) || type.startsWith("application/pdf");

// --- serving ----------------------------------------------------------------

/**
 * A stream that reports what it has handed on. A chunk counts as sent once
 * the server asks for the next one, which it does only after writing it out;
 * `complete` fires once the last chunk has gone. `close` fires exactly once,
 * however the stream ends: finished, cancelled, or the client gone.
 */
const metered = (
	source: AsyncIterable<Uint8Array>,
	signal: AbortSignal,
	hooks: {
		readonly sent?: (bytes: number) => void;
		readonly complete?: () => void;
		readonly close: () => void;
	},
): ReadableStream<Uint8Array> => {
	const iterator = source[Symbol.asyncIterator]();
	let pending = 0;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		hooks.close();
		void iterator.return?.()?.catch(() => {});
	};
	signal.addEventListener("abort", close, { once: true });
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (pending > 0) hooks.sent?.(pending);
				pending = 0;
				try {
					const next = await iterator.next();
					if (closed) return;
					if (next.done) {
						hooks.complete?.();
						controller.close();
						close();
						return;
					}
					pending = next.value.byteLength;
					controller.enqueue(next.value);
				} catch (error) {
					controller.error(error);
					close();
				}
			},
			cancel: close,
		},
		// Pulled only when the server wants more, so nothing is read ahead.
		{ highWaterMark: 0 },
	);
};

const notFound = (): Response =>
	new Response("No such file.", {
		status: 404,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});

export interface Downloads {
	/** One file, by its position on the command line: `/api/file/:index`. */
	readonly file: (request: Request, index: string) => Response;
	/** Every file, as one stored ZIP archive: `/api/zip`. */
	readonly zip: (request: Request) => Response;
	/** Which files are downloaded so far, and how many downloads are running. */
	readonly progress: () => {
		readonly downloaded: ReadonlyArray<number>;
		readonly active: number;
	};
	/** The downloaded files, in command-line order. */
	readonly downloaded: () => Array<DownloadedFile>;
	/** Resolves once no download is running. */
	readonly idle: () => Promise<void>;
}

export const createDownloads = (rules: DownloadRules): Downloads => {
	const files = rules.files;
	const spans = files.map((): Spans => []);
	const done = new Set<number>();
	let active = 0;
	let waiters: Array<() => void> = [];

	const begin = (): (() => void) => {
		active++;
		return () => {
			active--;
			if (active > 0) return;
			for (const wake of waiters) wake();
			waiters = [];
		};
	};

	const methodNotAllowed = (request: Request): Response | undefined =>
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: new Response("Method not allowed.", {
					status: 405,
					headers: { Allow: "GET, HEAD" },
				});

	const file = (request: Request, index: string): Response => {
		const refused = methodNotAllowed(request);
		if (refused) return refused;
		// Digits only: no sign, no exponent, nothing that parses to a surprise.
		const at = /^\d{1,9}$/.test(index) ? Number(index) : -1;
		const offered = files[at];
		if (!offered) return notFound();
		const stat = (() => {
			try {
				return statSync(offered.path);
			} catch {
				return undefined;
			}
		})();
		if (!stat?.isFile()) {
			return new Response(`${offered.name} is no longer on this machine.`, {
				status: 410,
			});
		}

		const size = stat.size;
		const download = new URL(request.url).searchParams.has("download");
		const inline = !download && previewable(offered.type);
		const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
		const lastModified = stat.mtime.toUTCString();
		const headers: Record<string, string> = {
			"Content-Type": offered.type,
			"Content-Disposition": contentDisposition(
				inline ? "inline" : "attachment",
				offered.name,
			),
			"Accept-Ranges": "bytes",
			ETag: etag,
			"Last-Modified": lastModified,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		};
		// The page's origin holds the token. A file opened in it must not be
		// able to run script there: an SVG can. Chrome refuses to show a
		// sandboxed PDF, and a PDF's viewer is its own process anyway.
		if (!offered.type.startsWith("application/pdf")) {
			headers["Content-Security-Policy"] = "sandbox";
		}

		// A resume names the version it has; a changed file starts over.
		const ifRange = request.headers.get("if-range");
		const range =
			ifRange !== null && ifRange !== etag && ifRange !== lastModified
				? ({ kind: "full" } as const)
				: parseRange(request.headers.get("range"), size);
		if (range.kind === "unsatisfiable") {
			return new Response(null, {
				status: 416,
				headers: { ...headers, "Content-Range": `bytes */${size}` },
			});
		}
		const [start, end] =
			range.kind === "partial" ? [range.start, range.end] : [0, size - 1];
		const length = Math.max(0, end - start + 1);
		headers["Content-Length"] = String(length);
		if (range.kind === "partial") {
			headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
		}
		const status = range.kind === "partial" ? 206 : 200;
		if (request.method === "HEAD")
			return new Response(null, { status, headers });

		const slice = Bun.file(offered.path).slice(start, start + length);
		// A preview goes straight from the file; only a download is counted.
		if (!download) return new Response(slice, { status, headers });

		let position = start;
		const body = metered(slice.stream(), request.signal, {
			sent: (bytes) => {
				spans[at] = addSpan(spans[at] ?? [], position, position + bytes);
				position += bytes;
				if (covers(spans[at] ?? [], size)) done.add(at);
			},
			complete: () => {
				if (covers(spans[at] ?? [], size)) done.add(at);
			},
			close: begin(),
		});
		return new Response(body, { status, headers });
	};

	const zip = (request: Request): Response => {
		const refused = methodNotAllowed(request);
		if (refused) return refused;
		const names = zipNames(files.map((offered) => offered.name));
		const entries = [];
		for (const [index, offered] of files.entries()) {
			try {
				const stat = statSync(offered.path);
				entries.push({
					name: names[index] ?? offered.name,
					size: stat.size,
					modified: stat.mtime,
					open: () =>
						Bun.file(offered.path)
							.slice(0, stat.size)
							.stream() as AsyncIterable<Uint8Array>,
				});
			} catch {
				return new Response(`${offered.name} is no longer on this machine.`, {
					status: 410,
				});
			}
		}
		const plan = planZip(entries);
		const headers = {
			"Content-Type": "application/zip",
			"Content-Disposition": contentDisposition("attachment", rules.zipName),
			"Content-Length": String(plan.size),
			// Its CRCs are only known as it streams, so it cannot resume.
			"Accept-Ranges": "none",
			"Cache-Control": "no-store",
		};
		if (request.method === "HEAD") return new Response(null, { headers });
		const body = metered(writeZip(plan), request.signal, {
			// A cut-off archive is unreadable, so only a whole one counts.
			complete: () => {
				for (const index of files.keys()) done.add(index);
			},
			close: begin(),
		});
		return new Response(body, { headers });
	};

	return {
		file,
		zip,
		progress: () => ({
			downloaded: [...done].sort((a, b) => a - b),
			active,
		}),
		downloaded: () =>
			files
				.filter((_, index) => done.has(index))
				.map(({ path, name, size }) => ({ path, name, size })),
		idle: () =>
			active === 0
				? Promise.resolve()
				: new Promise((resolve) => waiters.push(resolve)),
	};
};
