/**
 * Showing the user a page, and waiting for what they do with it.
 *
 * The caller writes one TSX file. This flattens it, installs whatever packages
 * it imports into an isolated temp directory, and hands the lot to a child
 * process. `Bun.serve` bundles the page for the browser on demand, so React
 * and anything else the page uses are never dependencies of this CLI — the
 * same trick `render` uses (ADR 12), pointed at a browser instead of
 * Playwright.
 *
 * The command blocks while the page is open, and that is what keeps it simple:
 * the parent owns the child, so there is no orphaned server to reap, no
 * pidfile, no heartbeat and no idle timer. When the command ends, the server
 * is gone. See `docs/adrs/0016`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Console, Context, Data, Effect, Layer } from "effect";
import { bareImports } from "./render.ts";
// Embedded as text: the bundler copies the characters and never follows the
// import of `./index.html` inside, which only exists in the staged temp
// directory. This file must therefore never be imported normally.
// @ts-expect-error text import: Bun inlines the file contents as a string
import childSource from "./ui-child.ts" with { type: "text" };

const CHILD_SOURCE: string = childSource;

export class UiError extends Data.TaggedError("UiError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

/** How the page ended. Everything but `error` is a normal outcome. */
export type UiStatus = "submitted" | "cancelled" | "done" | "timeout";

export interface UiResult {
	readonly status: UiStatus;
	readonly payload: unknown;
	readonly elapsedMs: number;
	/** The URL that was opened, echoed back so a log records where it went. */
	readonly url: string;
}

export interface UiRequest {
	readonly appPath: string;
	/** `present` injects a Done button and expects no `infer.submit` call. */
	readonly mode: "ask" | "present";
	readonly data: unknown;
	readonly title: string;
	readonly timeoutMs: number;
	/** 0 asks the OS for a free port, so parallel runs never collide. */
	readonly port: number;
	readonly share: boolean;
	readonly tailwind: boolean;
	readonly head?: string;
	readonly open: boolean;
}

export interface UiShape {
	readonly run: (request: UiRequest) => Effect.Effect<UiResult, UiError>;
}

export class Ui extends Context.Service<Ui, UiShape>()("Ui") {}

// --- the page -------------------------------------------------------------

/**
 * A random path segment that stands in for authentication.
 *
 * The server cannot tell the user apart from anything else that reaches the
 * port — another local process, a stray tab, or with `--share` any device on
 * the tailnet. Since the page carries the data *and* accepts the answer, an
 * unguessable URL is both the read and the write control.
 */
export const newToken = (): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

/**
 * Escapes a JSON string for embedding in a `<script>` element.
 *
 * `</script>` inside a string would close the element early. Escaping every
 * `<` is blunt but total, and survives a round trip because `<` is
 * ordinary JSON.
 */
export const escapeForScript = (json: string): string =>
	json.replace(/</g, "\\u003c");

const BASE_CSS = `
:root { color-scheme: light dark; --infer-fg: #111; --infer-bg: #fff; --infer-line: #d4d4d8; }
@media (prefers-color-scheme: dark) {
  :root { --infer-fg: #ededed; --infer-bg: #0b0b0c; --infer-line: #3f3f46; }
}
html, body { margin: 0; padding: 0; background: var(--infer-bg); color: var(--infer-fg); }
body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
#infer-bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  display: flex; gap: 10px; align-items: center; justify-content: flex-end;
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  background: var(--infer-bg); border-top: 1px solid var(--infer-line);
  font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
}
#infer-bar button {
  font: inherit; padding: 9px 18px; border-radius: 8px; border: 1px solid var(--infer-line);
  background: var(--infer-fg); color: var(--infer-bg); cursor: pointer; min-height: 40px;
}
#infer-bar details { margin-right: auto; }
#infer-bar summary { cursor: pointer; opacity: .55; }
#infer-bar details[open] { position: absolute; bottom: 100%; left: 0; right: 0;
  background: var(--infer-bg); border-top: 1px solid var(--infer-line); padding: 10px 14px; }
#infer-raw { display: block; width: 100%; box-sizing: border-box; min-height: 90px;
  margin: 8px 0; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--infer-bg); color: var(--infer-fg);
  border: 1px solid var(--infer-line); border-radius: 6px; padding: 8px; }
#infer-sent { padding: 18vh 24px; text-align: center; opacity: .7; }
body.infer-has-bar { padding-bottom: 76px; }
`.trim();

/**
 * The client half of the contract, as a classic script so it runs before the
 * page module and `window.infer` is there when the page's own code starts.
 */
const harness = (token: string, mode: "ask" | "present"): string =>
	`
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var MODE = ${JSON.stringify(mode)};
  var sent = false;

  function post(status, payload) {
    if (sent) return Promise.resolve();
    sent = true;
    return fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-infer-token": TOKEN },
      body: JSON.stringify({ status: status, payload: payload === undefined ? null : payload })
    }).catch(function () {}).then(function () {
      document.body.innerHTML =
        '<div id="infer-sent"><p>Sent back to the CLI.</p><p>You can close this tab.</p></div>';
    });
  }

  function report(message) {
    try {
      fetch("/api/log", {
        method: "POST",
        headers: { "content-type": "text/plain", "x-infer-token": TOKEN },
        body: String(message).slice(0, 2000)
      }).catch(function () {});
    } catch (e) {}
  }

  var slot = document.getElementById("infer-data");
  var data = null;
  if (slot && slot.textContent.trim() !== "") {
    try { data = JSON.parse(slot.textContent); }
    catch (e) { report("could not parse --data: " + e); }
  }

  window.infer = {
    data: data,
    submit: function (payload) { return post("submitted", payload); },
    cancel: function (reason) { return post("cancelled", reason === undefined ? null : reason); },
    done: function () { return post("done", null); }
  };

  window.addEventListener("error", function (e) {
    report((e.message || "error") + " @ " + (e.filename || "?") + ":" + (e.lineno || 0));
  });
  window.addEventListener("unhandledrejection", function (e) {
    report("unhandled rejection: " + (e.reason && e.reason.stack ? e.reason.stack : e.reason));
  });

  // The escape hatch. Page code is generated, so it will sometimes be broken;
  // without a path that does not depend on it, a broken page is a hung CLI.
  function bar() {
    var el = document.createElement("div");
    el.id = "infer-bar";
    el.innerHTML =
      '<details><summary>raw answer</summary>' +
      '<textarea id="infer-raw" spellcheck="false" placeholder=\\'{"picked": [1, 2]}\\'></textarea>' +
      '<button type="button" id="infer-raw-send">send this JSON</button></details>' +
      (MODE === "present" ? '<button type="button" id="infer-done">Done</button>' : "");
    document.body.appendChild(el);
    document.body.classList.add("infer-has-bar");

    el.querySelector("#infer-raw-send").addEventListener("click", function () {
      var text = el.querySelector("#infer-raw").value.trim();
      var parsed = null;
      if (text !== "") {
        try { parsed = JSON.parse(text); }
        catch (e) { alert("Not valid JSON: " + e.message); return; }
      }
      post("submitted", parsed);
    });

    var doneButton = el.querySelector("#infer-done");
    if (doneButton) doneButton.addEventListener("click", function () { post("done", null); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bar);
  } else {
    bar();
  }
})();
`.trim();

export const buildPage = (options: {
	readonly token: string;
	readonly mode: "ask" | "present";
	readonly title: string;
	readonly data: unknown;
	readonly tailwind: boolean;
	readonly head?: string;
}): string => {
	const dataJson =
		options.data === undefined
			? ""
			: escapeForScript(JSON.stringify(options.data));
	const head = [
		`<title>${options.title.replace(/[<&]/g, "")}</title>`,
		`<style>${BASE_CSS}</style>`,
	];
	// Same CDN script `render` injects, so a page can be styled with class
	// names and nothing else. Needs network; `--no-tailwind` skips it.
	if (options.tailwind) {
		head.push('<script src="https://cdn.tailwindcss.com"></script>');
	}
	if (options.head) head.push(options.head);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head.join("\n")}
</head>
<body>
<div id="root"></div>
<script id="infer-data" type="application/json">${dataJson}</script>
<script>${harness(options.token, options.mode)}</script>
<script type="module" src="./app.js"></script>
</body>
</html>`;
};

// --- staging --------------------------------------------------------------

const write = (path: string, contents: string) =>
	Effect.tryPromise({
		try: () => Bun.write(path, contents),
		catch: (cause) =>
			new UiError({ reason: `Could not write ${path}: ${cause}` }),
	});

/**
 * Flattens the page and its relative imports into one browser bundle.
 *
 * Package imports stay bare and are installed separately; relative imports are
 * inlined, which is what lets the file leave its own project. `render` does
 * the same thing for `target: "bun"`; this one targets a browser, so the two
 * do not share a helper.
 *
 * Returns the bare specifiers left in the bundle, which *are* the page's
 * dependencies — better than guessing them from the original source.
 */
export const flattenApp = (
	appPath: string,
	dir: string,
): Effect.Effect<ReadonlyArray<string>, UiError> =>
	Effect.gen(function* () {
		const entry = resolve(appPath);
		const exists = yield* Effect.tryPromise({
			try: () => Bun.file(entry).exists(),
			catch: () => new UiError({ reason: `Could not read ${entry}` }),
		});
		if (!exists) {
			return yield* Effect.fail(
				new UiError({ reason: `Page not found: ${entry}` }),
			);
		}

		const built = yield* Effect.tryPromise({
			try: () =>
				Bun.build({
					entrypoints: [entry],
					target: "browser",
					packages: "external",
					// Bun compiles JSX to `jsxDEV` from `react/jsx-dev-runtime` by
					// default, but the page is served in production mode, where React
					// resolves that specifier to a build without the export — every
					// page then dies with "jsxDEV is not a function". This define
					// switches Bun to `jsx` from `react/jsx-runtime`. The video
					// renderer hit the identical wall (ADR 12).
					define: { "process.env.NODE_ENV": JSON.stringify("production") },
				}),
			catch: (cause) =>
				new UiError({ reason: `Could not bundle the page: ${cause}` }),
		});
		if (!built.success || built.outputs[0] === undefined) {
			return yield* Effect.fail(
				new UiError({
					reason: `Could not bundle the page:\n${built.logs.map(String).join("\n")}`,
				}),
			);
		}
		const code = yield* Effect.tryPromise({
			try: () => built.outputs[0]?.text() as Promise<string>,
			catch: (cause) =>
				new UiError({ reason: `Could not read the bundle: ${cause}` }),
		});
		yield* write(join(dir, "app.js"), code);
		return bareImports(code);
	});

/**
 * Installs the page's packages into the staged directory.
 *
 * This cannot rely on `bun --install=fallback`, even though the child runs
 * with it. Auto-install resolves modules *in process*, and the HTML bundler
 * behind `Bun.serve` resolves from the filesystem, so it never sees them and
 * answers `500 Build Failed`. The same split already bit the video renderer
 * (ADR 12). Warm installs come out of Bun's global cache in well under a
 * second.
 */
const installDeps = (
	dir: string,
	deps: ReadonlyArray<string>,
): Effect.Effect<void, UiError> =>
	Effect.gen(function* () {
		if (deps.length === 0) return;
		yield* write(
			join(dir, "package.json"),
			JSON.stringify({ name: "infer-ui-page", private: true }),
		);
		yield* Console.error(
			`  Installing ${deps.length} package${deps.length === 1 ? "" : "s"}...`,
		);
		const result = yield* Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(["bun", "install", ...deps], {
					cwd: dir,
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stderr, code] = await Promise.all([
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return { stderr, code };
			},
			catch: (cause) =>
				new UiError({
					reason: `Could not install the page's packages: ${cause}`,
				}),
		});
		if (result.code !== 0) {
			return yield* Effect.fail(
				new UiError({
					reason: `Could not install the page's packages:\n${result.stderr.trim()}`,
				}),
			);
		}
	});

const withTempDir = <A, E>(
	use: (dir: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | UiError> =>
	Effect.acquireUseRelease(
		Effect.try({
			try: () => mkdtempSync(join(tmpdir(), "infer-ui-")),
			catch: (cause) =>
				new UiError({ reason: `Could not create a temp directory: ${cause}` }),
		}),
		use,
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);

// --- tailnet --------------------------------------------------------------

/**
 * Pulls the public URL out of `tailscale serve` output.
 *
 * The command prints a short report; the one line that matters is the
 * `https://…ts.net/` it is now proxying.
 */
export const parseServeUrl = (output: string): string | null =>
	output.match(/https:\/\/[a-z0-9.-]+\.ts\.net\/?/i)?.[0].replace(/\/$/, "") ??
	null;

const runTailscale = (
	args: ReadonlyArray<string>,
): Effect.Effect<{ stdout: string; code: number }, UiError> =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn(["tailscale", ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { stdout: `${stdout}\n${stderr}`, code };
		},
		catch: () =>
			new UiError({
				reason:
					"--share needs the tailscale command, which is not on PATH.\nInstall Tailscale, or drop --share to stay on localhost.",
			}),
	});

/**
 * Proxies the local port onto the tailnet over HTTPS.
 *
 * `serve` rather than binding the tailnet address directly: the process stays
 * on loopback so it is never exposed to whatever other network this machine
 * is on, and HTTPS makes the page a secure context, which is what the
 * clipboard API requires on a phone.
 */
const startShare = (port: number): Effect.Effect<string, UiError> =>
	Effect.gen(function* () {
		// `--bg` config lives in tailscaled and outlives this process, so a run
		// killed hard would leave it behind. Clearing first makes it idempotent.
		yield* runTailscale(["serve", "reset"]);
		const result = yield* runTailscale([
			"serve",
			"--bg",
			"--https=443",
			`http://127.0.0.1:${port}`,
		]);
		const url = parseServeUrl(result.stdout);
		if (result.code !== 0 || url === null) {
			return yield* Effect.fail(
				new UiError({
					reason: `Could not share over the tailnet:\n${result.stdout.trim()}`,
				}),
			);
		}
		return url;
	});

const stopShare = Effect.gen(function* () {
	yield* runTailscale(["serve", "reset"]).pipe(Effect.catch(() => Effect.void));
});

// --- running --------------------------------------------------------------

const openInBrowser = (url: string): Effect.Effect<void> =>
	Effect.sync(() => {
		try {
			const opener = process.platform === "darwin" ? "open" : "xdg-open";
			Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
		} catch {}
	});

/** Waits for the child to report the port it actually bound. */
const awaitReady = (
	path: string,
	isRunning: () => boolean,
): Effect.Effect<number, UiError> =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 300; attempt++) {
			const file = Bun.file(path);
			if (yield* Effect.promise(() => file.exists())) {
				const text = yield* Effect.promise(() => file.text());
				const port = Number(JSON.parse(text).port);
				if (Number.isFinite(port)) return port;
			}
			if (!isRunning()) break;
			yield* Effect.sleep("50 millis");
		}
		return yield* Effect.fail(
			new UiError({
				reason: "The page server never came up; see the output above.",
			}),
		);
	});

export const describeTimeout = (ms: number): string => {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
};

const make = (): UiShape => ({
	run: (request) =>
		withTempDir((dir) =>
			Effect.gen(function* () {
				const token = newToken();
				const deps = yield* flattenApp(request.appPath, dir);
				yield* installDeps(dir, deps);
				yield* write(
					join(dir, "index.html"),
					buildPage({
						token,
						mode: request.mode,
						title: request.title,
						data: request.data,
						tailwind: request.tailwind,
						head: request.head,
					}),
				);
				const childPath = join(dir, "ui-child.ts");
				yield* write(childPath, CHILD_SOURCE);

				const readyPath = join(dir, "ready.json");
				const resultPath = join(dir, "result.json");
				const job = JSON.stringify({
					token,
					port: request.port,
					timeoutMs: request.timeoutMs,
					readyPath,
					resultPath,
				});

				const started = Date.now();

				return yield* Effect.acquireUseRelease(
					Effect.sync(() =>
						Bun.spawn(["bun", "run", childPath, job], {
							cwd: dir,
							stdout: "inherit",
							stderr: "inherit",
						}),
					),
					(proc) =>
						Effect.gen(function* () {
							const port = yield* awaitReady(
								readyPath,
								() => proc.exitCode === null,
							);

							const url = yield* Effect.acquireUseRelease(
								request.share
									? startShare(port)
									: Effect.succeed(`http://127.0.0.1:${port}`),
								(base) =>
									Effect.gen(function* () {
										const full = `${base}/${token}`;
										yield* Console.error(`\n  ${full}\n`);
										yield* Console.error(
											`  Waiting for you — ${describeTimeout(request.timeoutMs)} timeout, Ctrl-C to give up.`,
										);
										if (request.open) yield* openInBrowser(full);

										const code = yield* Effect.promise(() => proc.exited);
										if (code !== 0) {
											return yield* Effect.fail(
												new UiError({
													reason:
														"The page server failed; see the output above.",
												}),
											);
										}
										return full;
									}),
								() => (request.share ? stopShare : Effect.void),
							);

							const raw = yield* Effect.tryPromise({
								try: () => Bun.file(resultPath).text(),
								catch: () =>
									new UiError({
										reason: "The page server left no answer behind.",
									}),
							});
							const parsed = JSON.parse(raw) as {
								status: UiStatus;
								payload: unknown;
							};
							return {
								status: parsed.status,
								payload: parsed.payload ?? null,
								elapsedMs: Date.now() - started,
								url,
							};
						}),
					(proc) => Effect.sync(() => proc.kill()),
				);
			}),
		),
});

export const layer: Layer.Layer<Ui> = Layer.sync(Ui)(make);
