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

import { join } from "node:path";
import {
	Console,
	Context,
	Data,
	Deferred,
	Effect,
	Fiber,
	type FileSystem,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	type Scope,
	Stream,
} from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { escapeForScript, inlineScript } from "./html.ts";
import { bareImports, buildStandalone, isolateComposition } from "./render.ts";
import { prependToHead } from "./render-html.ts";
import {
	install,
	type Platform,
	readFile,
	run,
	tempDir,
	writeFile,
} from "./stage.ts";
import { TAILWIND_NAME, TAILWIND_PACKAGE } from "./tailwind.ts";
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
	readonly head?: string;
	/** Link the CSS the page imported, which the standalone build inlines. */
	readonly stylesheet?: boolean;
}): string => {
	const dataJson =
		options.data === undefined
			? ""
			: escapeForScript(JSON.stringify(options.data));
	const head = [
		`<title>${options.title.replace(/[<&]/g, "")}</title>`,
		`<style>${BASE_CSS}</style>`,
	];
	if (options.stylesheet) {
		head.push('<link rel="stylesheet" href="./composition.css">');
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

export interface FlattenedApp {
	/** The bare specifiers left in the bundle, which *are* its dependencies. */
	readonly deps: ReadonlyArray<string>;
	/** Whether the page imported CSS, written beside it as `composition.css`. */
	readonly css: boolean;
}

/**
 * Flattens the page and its relative imports into `app.js` inside `dir`.
 *
 * The same pass `render` uses, pointed at a browser: packages stay bare and are
 * installed separately, relative imports are inlined so the page can leave its
 * project, and imported files become data URIs. JSX is compiled against the
 * production runtime the page is served with — Bun's default `jsxDEV` does not
 * exist there, and every page would die with "jsxDEV is not a function".
 */
export const flattenApp = (
	appPath: string,
	dir: string,
): Effect.Effect<FlattenedApp, UiError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const isolated = yield* isolateComposition({ path: appPath }, dir, {
			target: "browser",
			productionJsx: true,
			inlineImports: true,
			fileName: "app.js",
		});
		const code = yield* readFile(isolated.path);
		return { deps: bareImports(code), css: isolated.css };
	}).pipe(Effect.mapError((error) => new UiError({ reason: error.message })));

// --- tailnet --------------------------------------------------------------

/**
 * Pulls the public URL out of `tailscale serve` output.
 *
 * The command prints a short report; the one line that matters is the
 * `https://…ts.net/` it is now proxying.
 */
export const parseServeUrl = (output: string): string | null =>
	output
		.match(/https:\/\/[a-z0-9.-]+\.ts\.net(:\d+)?\/?/i)?.[0]
		.replace(/\/$/, "") ?? null;

/**
 * Shares the local server on the tailnet over HTTPS, for as long as this run.
 *
 * `serve` rather than binding the tailnet address: the server stays on
 * loopback, never exposed to whatever other network this machine is on, and
 * HTTPS makes the page a secure context, which the clipboard API needs on a
 * phone.
 *
 * In the foreground, on an HTTPS port of its own — the local port's number,
 * which the OS already made unique. A foreground share lasts exactly as long
 * as its process, never enters the persistent serve config, and the process is
 * scoped to this run. The earlier `--bg` share needed `tailscale serve reset`
 * at start and exit, which deleted every other serve rule on the machine, and
 * let two concurrent shares on port 443 clobber each other.
 */
/**
 * Runs the foreground share, and stops it when our stdin closes.
 *
 * `tailscale serve` has no notion of its parent, so a kill -9 of this CLI
 * would leave it proxying a dead port forever. The wrapper holds a copy of the
 * stdin pipe this process keeps open; however this process ends, the OS closes
 * the pipe, `cat` returns, and the share is stopped. A TERM or INT — Effect
 * ending the scope — stops it through the trap instead. The explicit `<&3`
 * matters: POSIX gives a background job `/dev/null` as stdin otherwise, and
 * `cat` would return at once.
 */
const SHARE_SCRIPT = `
exec 3<&0
tailscale serve --https="$1" "http://127.0.0.1:$1" &
t=$!
trap 'kill "$t" 2>/dev/null' INT TERM
(cat <&3 >/dev/null; kill "$t" 2>/dev/null) >/dev/null 2>&1 &
wait "$t"
`;

const shareOnce = (
	port: number,
): Effect.Effect<
	string,
	UiError | ShareBusy,
	ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
	Effect.gen(function* () {
		const handle = yield* ChildProcess.make(
			"sh",
			["-c", SHARE_SCRIPT, "infer-share", String(port)],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		).pipe(
			Effect.mapError(
				() =>
					new UiError({
						reason:
							"--share needs the tailscale command, which is not on PATH.\nInstall Tailscale, or drop --share to stay on localhost.",
					}),
			),
		);

		// It prints the URL, then blocks until it is stopped.
		const found = yield* handle.stdout.pipe(
			Stream.decodeText(),
			Stream.scan(
				() => "",
				(seen: string, chunk: string) => seen + chunk,
			),
			Stream.map(parseServeUrl),
			Stream.filter((url): url is string => url !== null),
			Stream.runHead,
			Effect.timeout("15 seconds"),
			Effect.orElseSucceed(() => Option.none<string>()),
		);
		if (Option.isSome(found)) return found.value;

		// It exited or stalled without a URL: HTTPS certificates not enabled for
		// the tailnet, logged out, and so on — tailscale says which on stderr.
		const why = yield* handle.stderr.pipe(
			Stream.decodeText(),
			Stream.mkString,
			Effect.timeout("2 seconds"),
			Effect.orElseSucceed(() => ""),
		);
		const reason = why
			.split("\n")
			.filter((line) => line.trim() !== "" && !line.includes("client version"))
			.join("\n");
		if (/tailscale: (command )?not found/i.test(reason)) {
			return yield* Effect.fail(
				new UiError({
					reason:
						"--share needs the tailscale command, which is not on PATH.\nInstall Tailscale, or drop --share to stay on localhost.",
				}),
			);
		}
		if (/try again|etag mismatch/i.test(reason)) {
			return yield* Effect.fail(new ShareBusy({ reason }));
		}
		return yield* Effect.fail(
			new UiError({
				reason: `Could not share over the tailnet:\n${reason || "tailscale serve printed no URL."}`,
			}),
		);
	});

/**
 * Starting two shares in the same instant collides on tailscaled's config
 * update — "Another client is changing the serve config; please try again" —
 * so that answer is retried, with jitter so simultaneous starts spread out.
 */
class ShareBusy extends Data.TaggedError("ShareBusy")<{
	readonly reason: string;
}> {}

const share = (
	port: number,
): Effect.Effect<
	string,
	UiError,
	ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
	shareOnce(port).pipe(
		Effect.retry({
			schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
			times: 6,
			while: (error) => error._tag === "ShareBusy",
		}),
		Effect.catchTag("ShareBusy", (busy) =>
			Effect.fail(
				new UiError({
					reason: `Could not share over the tailnet:\n${busy.reason}`,
				}),
			),
		),
	);

// --- running --------------------------------------------------------------

const openInBrowser = (
	url: string,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
	run(process.platform === "darwin" ? "open" : "xdg-open", [url], {
		stdout: "ignore",
		stderr: "ignore",
	}).pipe(Effect.ignore);

/** One line the page server writes to stdout. */
const Message = Schema.fromJsonString(
	Schema.Union([
		Schema.Struct({ type: Schema.Literal("ready"), port: Schema.Finite }),
		Schema.Struct({
			type: Schema.Literal("answer"),
			status: Schema.Literals(["submitted", "cancelled", "done", "timeout"]),
			payload: Schema.optional(Schema.Unknown),
		}),
	]),
);
type Message = typeof Message.Type;
type Answer = Extract<Message, { type: "answer" }>;

export const describeTimeout = (ms: number): string => {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
};

const make = (platform: Context.Context<Platform>): UiShape => ({
	run: Effect.fn("Ui.run")(
		function* (request: UiRequest) {
			const dir = yield* tempDir("infer-ui-");
			const token = newToken();
			const app = yield* flattenApp(request.appPath, dir);
			yield* install(
				dir,
				request.tailwind ? [...app.deps, TAILWIND_PACKAGE] : app.deps,
			);
			const indexPath = join(dir, "index.html");
			yield* writeFile(
				indexPath,
				buildPage({
					token,
					mode: request.mode,
					title: request.title,
					data: request.data,
					head: request.head,
					stylesheet: app.css,
				}),
			);
			// The same standalone build `render html` uses: one file with the
			// script, CSS and imported files inlined, served as one response.
			const built = yield* buildStandalone(dir, indexPath);
			// Added after the build, as render html does, so the bundler never
			// parses Tailwind's 280 KB. See `docs/adrs/0020`.
			const html = request.tailwind
				? prependToHead(
						built,
						inlineScript(yield* readFile(Bun.resolveSync(TAILWIND_NAME, dir))),
					)
				: built;
			const pagePath = join(dir, "page.html");
			yield* writeFile(pagePath, html);

			const childPath = join(dir, "ui-child.ts");
			yield* writeFile(childPath, CHILD_SOURCE);
			const job = JSON.stringify({
				token,
				port: request.port,
				timeoutMs: request.timeoutMs,
				pagePath,
			});
			const started = Date.now();

			// Scoped: the server is killed when this run ends, however it ends —
			// an answer, a failure, or Ctrl-C.
			const server = yield* ChildProcess.make("bun", ["run", childPath, job], {
				cwd: dir,
				// Held open and never written: the child exits when it closes,
				// which happens even if this process is killed with -9.
				stdin: "pipe",
				// The protocol: one JSON line when listening, one with the answer.
				stdout: "pipe",
				stderr: "inherit",
			});
			const ready = yield* Deferred.make<number>();
			const answer = yield* Ref.make(Option.none<Answer>());
			const reader = yield* server.stdout.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) =>
					Option.match(Schema.decodeUnknownOption(Message)(line), {
						onNone: () => Effect.void,
						onSome: (message) =>
							message.type === "ready"
								? Deferred.succeed(ready, message.port)
								: Ref.set(answer, Option.some(message)),
					}),
				),
				Effect.forkScoped,
			);
			// Either the server reports its port, or it exits without doing so.
			const port = yield* Effect.raceFirst(
				Deferred.await(ready),
				server.exitCode.pipe(
					Effect.andThen(
						Effect.fail(
							new UiError({
								reason: "The page server never came up; see the output above.",
							}),
						),
					),
				),
			);

			// Scoped like the server: the share ends when this run does.
			const base = request.share
				? yield* share(port)
				: `http://127.0.0.1:${port}`;
			const url = `${base}/${token}`;
			yield* Console.error(`\n  ${url}\n`);
			yield* Console.error(
				`  Waiting for you — ${describeTimeout(request.timeoutMs)} timeout, Ctrl-C to give up.`,
			);
			if (request.open) yield* openInBrowser(url);

			const code = yield* server.exitCode;
			if (code !== 0) {
				return yield* Effect.fail(
					new UiError({
						reason: "The page server failed; see the output above.",
					}),
				);
			}

			// Its stdout closes with it, so the reader has seen every line.
			yield* Fiber.join(reader).pipe(Effect.ignore);
			const result = yield* Ref.get(answer);
			if (Option.isNone(result)) {
				return yield* Effect.fail(
					new UiError({ reason: "The page server left no answer behind." }),
				);
			}
			return {
				status: result.value.status,
				payload: result.value.payload ?? null,
				elapsedMs: Date.now() - started,
				url,
			};
		},
		(effect) =>
			effect.pipe(
				Effect.scoped,
				Effect.mapError((error) =>
					error._tag === "UiError"
						? error
						: new UiError({ reason: error.message }),
				),
				Effect.provideContext(platform),
			),
	),
});

/** Built against the platform services, so `run` needs nothing more. */
export const layer: Layer.Layer<Ui, never, Platform> = Layer.effect(Ui)(
	Effect.gen(function* () {
		return make(yield* Effect.context<Platform>());
	}),
);
