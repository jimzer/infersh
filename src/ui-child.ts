/**
 * The page server.
 *
 * Runs as a separate process against packages the parent installed into the
 * staged directory, so React and whatever else the page imports are never
 * dependencies of the CLI itself.
 *
 * This file is never imported by the CLI. It is embedded as text and written
 * into a temp directory beside the generated `index.html` and `app.js`, which
 * is why its only import is that page. See `docs/adrs/0016`.
 */

// Only exists in the staged temp directory; Bun resolves and bundles it at
// runtime, which is what lets the page be written after this file was built.
import index from "./index.html";

interface Job {
	readonly token: string;
	readonly port: number;
	readonly timeoutMs: number;
	readonly readyPath: string;
	readonly resultPath: string;
}

const job: Job = JSON.parse(process.argv[2] ?? "{}");

let settled = false;

const finish = async (status: string, payload: unknown): Promise<void> => {
	if (settled) return;
	settled = true;
	await Bun.write(job.resultPath, JSON.stringify({ status, payload }));
	// Let the browser's own request finish before the socket goes away,
	// otherwise the page reports a network error on an answer that landed.
	setTimeout(() => {
		server.stop(true);
		process.exit(0);
	}, 50);
};

const authorised = (request: Request): boolean =>
	request.headers.get("x-infer-token") === job.token;

const server = Bun.serve({
	port: job.port,
	hostname: "127.0.0.1",
	// Production mode still bundles the page on demand at the first request,
	// and skips the hot-reload client and React's development build: 178KB
	// instead of 971KB, which is worth having over a phone connection.
	development: false,
	routes: {
		// The token is the route, so Bun's own router does the check. A query
		// parameter would mean a custom handler, and the bundled page is not
		// something a handler can return.
		[`/${job.token}`]: index,

		"/api/submit": {
			POST: async (request: Request) => {
				if (!authorised(request))
					return new Response("forbidden", { status: 403 });
				const body = (await request.json().catch(() => null)) as {
					status?: string;
					payload?: unknown;
				} | null;
				const status = body?.status ?? "submitted";
				await finish(status, body?.payload ?? null);
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
			{
				status: 404,
			},
		),
});

await Bun.write(job.readyPath, JSON.stringify({ port: server.port }));

setTimeout(() => {
	void finish("timeout", null);
}, job.timeoutMs);
