/**
 * The page server.
 *
 * Serves one page the CLI already built — a single self-contained HTML file,
 * the same standalone build `render html` produces — and reports back on
 * stdout: one JSON line when it is listening, one when the page has answered,
 * timed out or been cancelled. Page errors go to stderr, which the CLI shows.
 *
 * With `upload` in the job it also receives files, streamed to disk by
 * `ui-upload.ts`, and answers with where they were saved (ADR 33). With
 * `download` it serves the files named in the job, streamed from disk by
 * `ui-download.ts`, and answers with which were downloaded (ADR 34).
 *
 * This file is never imported by the CLI. It is embedded as text and written
 * into the run's temp directory beside the built page and its neighbours.
 * See `docs/adrs/0016`.
 */

import { createDownloads, type DownloadRules } from "./ui-download.ts";
import { createUploads, type UploadRules } from "./ui-upload.ts";

interface Job {
	readonly token: string;
	readonly port: number;
	readonly timeoutMs: number;
	readonly pagePath: string;
	readonly upload?: UploadRules;
	readonly download?: DownloadRules;
}

const job: Job = JSON.parse(process.argv[2] ?? "{}");

/** One line of the protocol the CLI reads from stdout. */
const send = (message: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};

const page = await Bun.file(job.pagePath).bytes();
// Compressed once, up front. A page carries React and Tailwind inline, about
// 500 KB; gzip brings it to roughly a third, which matters over --share on a
// phone and costs nothing locally.
const gzipped = Bun.gzipSync(page);

const uploads = job.upload ? createUploads(job.upload) : undefined;
const downloads = job.download ? createDownloads(job.download) : undefined;
const started = Date.now();

/**
 * A download page answers with the files downloaded, however it ended.
 *
 * An upload page answers with the ids of files it already sent; they become
 * the saved files, and every other upload is deleted. Any other ending deletes
 * them all, so nothing the human did not send is left in the folder.
 */
const settleAnswer = (status: string, payload: unknown): unknown => {
	// Whatever the ending, the files already downloaded are on their device.
	if (downloads) return { downloaded: downloads.downloaded() };
	if (!uploads) return payload;
	if (status !== "submitted") {
		uploads.discard();
		return payload;
	}
	const body = (payload ?? {}) as { files?: unknown; note?: unknown };
	const ids = Array.isArray(body.files)
		? body.files.filter((id): id is string => typeof id === "string")
		: undefined;
	const note = typeof body.note === "string" ? body.note.trim() : "";
	return { files: uploads.keep(ids), ...(note ? { note } : {}) };
};

let settled = false;

/**
 * Done pressed while a download is still streaming must not cut it off: the
 * server stays up until it ends, but no longer than the run's own timeout.
 */
const drain = async (): Promise<void> => {
	const { active } = downloads?.progress() ?? { active: 0 };
	if (active === 0 || !downloads) return;
	console.error(
		`  Waiting for ${active} download${active === 1 ? "" : "s"} to finish…`,
	);
	const left = job.timeoutMs - (Date.now() - started);
	await Promise.race([downloads.idle(), Bun.sleep(Math.max(0, left))]);
};

const finish = async (status: string, payload: unknown): Promise<void> => {
	if (settled) return;
	settled = true;
	if (status !== "timeout") await drain();
	send({ type: "answer", status, payload: settleAnswer(status, payload) });
	// Let the browser's own request finish before the socket goes away,
	// otherwise the page reports a network error on an answer that landed.
	setTimeout(() => {
		server.stop(true);
		process.exit(0);
	}, 50);
};

/** Ending without an answer — a signal, or the CLI gone — keeps no upload. */
const abandon = (code: number): never => {
	if (!settled) uploads?.discard();
	process.exit(code);
};

/**
 * The token, from a header — or, for what the browser fetches by itself
 * (an image, a video, a download), from the query string.
 */
const authorised = (request: Request): boolean =>
	(request.headers.get("x-infer-token") ??
		new URL(request.url).searchParams.get("token")) === job.token;

const forbidden = (): Response => new Response("forbidden", { status: 403 });

const servePage = (request: Request): Response => {
	const headers = {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		Vary: "Accept-Encoding",
	};
	return /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
		? new Response(gzipped, {
				headers: { ...headers, "Content-Encoding": "gzip" },
			})
		: new Response(page, { headers });
};

const server = Bun.serve({
	port: job.port,
	hostname: "127.0.0.1",
	// Bun refuses bodies over 128 MB by default. An upload's own --max-size,
	// checked as it streams, is the limit that applies.
	maxRequestBodySize: Number.MAX_SAFE_INTEGER,
	routes: {
		// The token is the route, so Bun's own router does the check.
		[`/${job.token}`]: servePage,

		"/api/submit": {
			POST: async (request: Request) => {
				if (!authorised(request)) return forbidden();
				const body = (await request.json().catch(() => null)) as {
					status?: string;
					payload?: unknown;
				} | null;
				void finish(body?.status ?? "submitted", body?.payload ?? null);
				return Response.json({ ok: true });
			},
		},

		// The file is the raw body, its name and type in headers, so it streams
		// straight to disk with no multipart parsing and no buffering.
		"/api/upload": {
			POST: (request: Request) =>
				!authorised(request) || !uploads || settled
					? forbidden()
					: uploads.receive(request),
		},

		"/api/upload/:id": {
			DELETE: (request: Bun.BunRequest) =>
				!authorised(request) || !uploads
					? forbidden()
					: Response.json({
							removed: uploads.remove(request.params.id ?? ""),
						}),
		},

		// Files are addressed by their position in the job, never by a path.
		"/api/file/:index": (request: Bun.BunRequest) =>
			!authorised(request) || !downloads
				? forbidden()
				: downloads.file(request, request.params.index ?? ""),

		"/api/zip": (request: Request) =>
			!authorised(request) || !downloads ? forbidden() : downloads.zip(request),

		"/api/downloads": {
			GET: (request: Request) =>
				!authorised(request) || !downloads
					? forbidden()
					: Response.json(downloads.progress()),
		},

		// Generated page code will sometimes be broken. Surfacing the error on
		// the CLI's stderr beats leaving a blank screen and no explanation.
		"/api/log": {
			POST: async (request: Request) => {
				if (!authorised(request)) return forbidden();
				console.error(`  page: ${(await request.text()).slice(0, 2000)}`);
				return new Response("ok");
			},
		},
	},
	fetch: () =>
		new Response(
			"Not found. Open the exact URL infer printed, token included.",
			{ status: 404 },
		),
});

send({ type: "ready", port: server.port });

// The CLI stops this process with SIGTERM when its run ends without an
// answer; a terminal's Ctrl-C also reaches it directly as SIGINT.
process.on("SIGTERM", () => abandon(143));
process.on("SIGINT", () => abandon(130));

// The parent holds this process's stdin open and never writes to it. However
// the parent ends — even kill -9, which no cleanup code can catch — the OS
// closes it, and the server must not outlive the command that started it.
void (async () => {
	for await (const _ of Bun.stdin.stream()) {
		// Nothing is ever sent; only the end matters.
	}
	abandon(0);
})();

setTimeout(() => void finish("timeout", null), job.timeoutMs);
