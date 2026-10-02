/**
 * The page server.
 *
 * Serves one page the CLI already built — a single self-contained HTML file,
 * the same standalone build `render html` produces — and reports back on
 * stdout: one JSON line when it is listening, one when the page has answered,
 * timed out or been cancelled. Page errors go to stderr, which the CLI shows.
 *
 * This file is never imported by the CLI. It is embedded as text and written
 * into the run's temp directory beside the built page. See `docs/adrs/0016`.
 */

interface Job {
	readonly token: string;
	readonly port: number;
	readonly timeoutMs: number;
	readonly pagePath: string;
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

let settled = false;

const finish = (status: string, payload: unknown): void => {
	if (settled) return;
	settled = true;
	send({ type: "answer", status, payload });
	// Let the browser's own request finish before the socket goes away,
	// otherwise the page reports a network error on an answer that landed.
	setTimeout(() => {
		server.stop(true);
		process.exit(0);
	}, 50);
};

const authorised = (request: Request): boolean =>
	request.headers.get("x-infer-token") === job.token;

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
	routes: {
		// The token is the route, so Bun's own router does the check.
		[`/${job.token}`]: servePage,

		"/api/submit": {
			POST: async (request: Request) => {
				if (!authorised(request))
					return new Response("forbidden", { status: 403 });
				const body = (await request.json().catch(() => null)) as {
					status?: string;
					payload?: unknown;
				} | null;
				finish(body?.status ?? "submitted", body?.payload ?? null);
				return Response.json({ ok: true });
			},
		},

		// Generated page code will sometimes be broken. Surfacing the error on
		// the CLI's stderr beats leaving a blank screen and no explanation.
		"/api/log": {
			POST: async (request: Request) => {
				if (!authorised(request))
					return new Response("forbidden", { status: 403 });
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

// The parent holds this process's stdin open and never writes to it. However
// the parent ends — even kill -9, which no cleanup code can catch — the OS
// closes it, and the server must not outlive the command that started it.
void (async () => {
	for await (const _ of Bun.stdin.stream()) {
		// Nothing is ever sent; only the end matters.
	}
	process.exit(0);
})();

setTimeout(() => finish("timeout", null), job.timeoutMs);
