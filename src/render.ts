/**
 * Rendering TSX compositions to images and PDFs.
 *
 * The composition is flattened with `Bun.build`, staged in an isolated temp
 * directory, and handed to a `bun --install=fallback` child that owns the
 * whole render. React, Playwright and anything the composition imports are
 * resolved on demand from Bun's cache, so none of them are dependencies of
 * this CLI. See `docs/adrs/0012`.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
	Console,
	Context,
	Data,
	Effect,
	FileSystem,
	Layer,
	type Scope,
} from "effect";
import { inlineScript } from "./html.ts";
import { formatBytes } from "./output.ts";
// Embedded as text: the bundler copies the characters and never follows the
// imports inside, which is what keeps React and Playwright out of the bundle.
// Once a module is imported this way it is text for the whole build, so these
// two files must never be imported normally from here — consumers that need
// their values import `render-shared.ts` directly.
// @ts-expect-error text import: Bun inlines the file contents as a string
import childSource from "./render-child.ts" with { type: "text" };
import {
	assetRef,
	dataUri,
	ENTRY_SOURCE,
	HTML_CORE_DEPS,
	hasDefaultExport,
	htmlDocument,
	prependToHead,
	replaceJsonStrings,
	replaceStringLiterals,
} from "./render-html.ts";
// @ts-expect-error text import: Bun inlines the file contents as a string
import sharedSource from "./render-shared.ts" with { type: "text" };
import {
	CODECS,
	INDEX_SOURCE,
	PACKAGE_JSON_SOURCE,
	ROOT_SOURCE,
	TSCONFIG_SOURCE,
	VIDEO_CHILD_SOURCE,
	VIDEO_CORE_DEPS,
} from "./render-video-source.ts";
import {
	cacheDir,
	install,
	type Platform,
	readFile,
	run,
	type StageError,
	tempDir,
	writeFile,
} from "./stage.ts";
import { TAILWIND_NAME, TAILWIND_PACKAGE } from "./tailwind.ts";

export { CODECS };

/** The bare package specifiers left in a flattened composition bundle. */
export const bareImports = (code: string): ReadonlyArray<string> => {
	const found = new Set<string>();
	for (const match of code.matchAll(/from\s*"([^"]+)"/g)) {
		const spec = match[1];
		if (spec === undefined || spec.startsWith(".")) continue;
		// react/jsx-runtime and @scope/pkg/sub all install from their root.
		const parts = spec.split("/");
		found.add(
			spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec),
		);
	}
	return [...found];
};

const CHILD_SOURCE: string = childSource;

/**
 * The Playwright that drives image and pdf renders.
 *
 * Pinned, because each release names the exact headless-shell build it
 * launches — an unpinned one would silently swap the browser under every
 * render. It must equal the `playwright-core` devDependency, which supplies
 * the child's types; a test holds the two together. See `docs/adrs/0022`.
 */
export const PLAYWRIGHT_VERSION = "1.63.0";
const PLAYWRIGHT_PACKAGE = `playwright-core@${PLAYWRIGHT_VERSION}`;
const SHARED_SOURCE: string = sharedSource;

// These live here rather than in render-shared.ts because that file is text
// for the whole build, so nothing else may import values from it.
export const WAIT_EVENTS = ["load", "domcontentloaded", "networkidle"] as const;

export const PAPER_FORMATS = [
	"a4",
	"a3",
	"a5",
	"letter",
	"legal",
	"tabloid",
] as const;

export class RenderError extends Data.TaggedError("RenderError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

export interface CompositionSource {
	readonly path?: string;
	readonly inline?: string;
}

export interface RenderRequest {
	readonly source: CompositionSource;
	readonly props: unknown;
	readonly outputPath: string;
	readonly assetDir?: string;
	readonly head?: string;
	readonly tailwind: boolean;
	readonly waitUntil: string;
}

export interface ImageRequest extends RenderRequest {
	readonly width: number;
	readonly height?: number;
	readonly fullPage: boolean;
	readonly deviceScaleFactor: number;
	readonly transparent: boolean;
	readonly quality?: number;
}

export interface PdfRequest extends RenderRequest {
	readonly paperFormat?: string;
	readonly pageWidth?: string;
	readonly pageHeight?: string;
	readonly margin: {
		readonly top: string;
		readonly right: string;
		readonly bottom: string;
		readonly left: string;
	};
	readonly landscape: boolean;
	readonly scale: number;
}

export interface VideoRequest {
	readonly source: CompositionSource;
	readonly props: unknown;
	readonly outputPath: string;
	readonly assetDir?: string;
	/** Only explicitly-set flags, so an absent one never overrides the composition. */
	readonly dimensions: Record<string, number>;
	readonly codec: string;
	readonly concurrency?: number;
	readonly crf?: number;
	readonly scale?: number;
	readonly frameRange?: readonly [number, number] | number;
	readonly muted: boolean;
	/** Render this single frame as a still instead of encoding a video. */
	readonly frame?: number;
	readonly stillFormat?: string;
}

export interface HtmlRequest {
	readonly source: CompositionSource;
	readonly props: unknown;
	readonly outputPath: string;
	/** Files the composition names by path are embedded from here. */
	readonly assetDir?: string;
	readonly head?: string;
	readonly tailwind: boolean;
	readonly title: string;
}

export interface RenderShape {
	readonly toImage: (
		request: ImageRequest,
	) => Effect.Effect<string, RenderError>;
	readonly toPdf: (request: PdfRequest) => Effect.Effect<string, RenderError>;
	readonly toHtml: (request: HtmlRequest) => Effect.Effect<string, RenderError>;
	readonly toVideo: (
		request: VideoRequest,
	) => Effect.Effect<string, RenderError>;
}

export class Render extends Context.Service<Render, RenderShape>()("Render") {}

/** Everything a render step can fail with, before it reaches the caller. */
type Failure = RenderError | StageError;

/** Staging failures surface as render failures, with their message intact. */
const asRenderError = (error: Failure): RenderError =>
	error._tag === "StageError"
		? new RenderError({ reason: error.reason })
		: error;

/**
 * Flattens the composition and its relative imports into one self-contained
 * file inside `dir`.
 *
 * Package imports stay bare so the child installs them on demand; relative
 * imports are inlined, which is what lets the file leave its own project. The
 * temp directory has no `node_modules` above it, so a render cannot pick up
 * anything from wherever the composition happened to live.
 */
export interface IsolateOptions {
	/** `bun` for the image and pdf child; `browser` for an html page. */
	readonly target?: "bun" | "browser";
	/**
	 * Video renders need the production JSX runtime. Bun compiles JSX to
	 * `jsxDEV` from `react/jsx-dev-runtime` by default, which Remotion's
	 * production bundle resolves without that export, failing at the first
	 * frame with "jsxDEV is not a function". A NODE_ENV define switches Bun to
	 * `jsx` from `react/jsx-runtime`. (`production: true` does not.) An html
	 * page needs it for the same reason: it is bundled in production mode.
	 */
	readonly productionJsx?: boolean;
	/**
	 * Replace imported files (`import logo from "./logo.png"`) with data URIs.
	 * Otherwise they become paths to sibling files that the move into the
	 * temp directory leaves behind.
	 */
	readonly inlineImports?: boolean;
	/** Name of the flattened file inside `dir`. Defaults to `composition.tsx`. */
	readonly fileName?: string;
}

export interface Isolated {
	readonly path: string;
	/** Whether the composition imported CSS, written beside it as `composition.css`. */
	readonly css: boolean;
}

export const isolateComposition = (
	source: CompositionSource,
	dir: string,
	options: IsolateOptions = {},
): Effect.Effect<Isolated, Failure, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const entry = yield* Effect.gen(function* () {
			if (source.inline !== undefined) {
				if (/from\s*["']\.\.?\//.test(source.inline)) {
					return yield* Effect.fail(
						new RenderError({
							reason:
								"An inline composition cannot use relative imports, because there is no directory to resolve them against.\nPass a file path instead.",
						}),
					);
				}
				const inlinePath = join(dir, "inline.tsx");
				yield* writeFile(inlinePath, source.inline);
				return inlinePath;
			}
			const path = resolve(source.path as string);
			const fs = yield* FileSystem.FileSystem;
			const exists = yield* fs
				.exists(path)
				.pipe(Effect.orElseSucceed(() => false));
			if (!exists) {
				return yield* Effect.fail(
					new RenderError({ reason: `Composition not found: ${path}` }),
				);
			}
			return path;
		});

		const built = yield* Effect.tryPromise({
			try: () =>
				Bun.build({
					entrypoints: [entry],
					target: options.target ?? "bun",
					packages: "external",
					...(options.productionJsx
						? {
								define: {
									"process.env.NODE_ENV": JSON.stringify("production"),
								},
							}
						: {}),
				}),
			catch: (cause) =>
				new RenderError({
					reason: `Could not bundle the composition:\n${buildFailure(cause)}`,
				}),
		});
		// A composition that imports CSS gets a second output, and nothing
		// guarantees the code comes first, so pick it by kind.
		const script = built.outputs.find(
			(output) => output.kind === "entry-point",
		);
		if (!built.success || script === undefined) {
			return yield* Effect.fail(
				new RenderError({
					reason: `Could not bundle the composition:\n${built.logs.map(String).join("\n")}`,
				}),
			);
		}
		const read = (output: { text: () => Promise<string> }) =>
			Effect.tryPromise({
				try: () => output.text(),
				catch: (cause) =>
					new RenderError({ reason: `Could not read the bundle: ${cause}` }),
			});
		const bundled = yield* read(script);

		// Each imported file is an asset output, and the code refers to it by
		// exactly that output's path — so this is an exact swap, not a guess.
		const imported = new Map<string, string>();
		if (options.inlineImports) {
			for (const output of built.outputs) {
				if (output.kind !== "asset" || output.path.endsWith(".css")) continue;
				const bytes = yield* Effect.tryPromise({
					try: () => output.arrayBuffer(),
					catch: (cause) =>
						new RenderError({
							reason: `Could not read ${output.path}: ${cause}`,
						}),
				});
				imported.set(output.path, dataUri(output.type, new Uint8Array(bytes)));
			}
		}
		const code =
			imported.size === 0
				? bundled
				: replaceStringLiterals(
						bundled,
						(value) => imported.get(value) ?? null,
					);
		const isolated = join(dir, options.fileName ?? "composition.tsx");
		yield* writeFile(isolated, code);

		const stylesheets = built.outputs.filter((output) =>
			output.path.endsWith(".css"),
		);
		if (stylesheets.length > 0) {
			const css = yield* Effect.forEach(stylesheets, read);
			yield* writeFile(join(dir, "composition.css"), css.join("\n"));
		}
		return { path: isolated, css: stylesheets.length > 0 };
	});

/** Stages the worker and runs it, returning the path it wrote. */
const runChild = (
	request: RenderRequest,
	job: Record<string, unknown>,
): Effect.Effect<string, Failure, Platform | Scope.Scope> =>
	Effect.gen(function* () {
		const dir = yield* tempDir("infer-render-");
		// Without this an imported image becomes a path to a file the move into
		// the temp directory left behind, and renders as a broken icon.
		const { path: compositionPath } = yield* isolateComposition(
			request.source,
			dir,
			{ inlineImports: true },
		);
		yield* writeFile(join(dir, "render-shared.ts"), SHARED_SOURCE);
		const childPath = join(dir, "render-child.ts");
		yield* writeFile(childPath, CHILD_SOURCE);

		const payload = JSON.stringify({
			...job,
			compositionPath,
			props: request.props ?? {},
			outputPath: request.outputPath,
			assetDir: request.assetDir,
			head: request.head,
			playwrightPackage: PLAYWRIGHT_PACKAGE,
			tailwindPackage: request.tailwind ? TAILWIND_PACKAGE : undefined,
			waitUntil: request.waitUntil,
		});

		// stderr passes straight through rather than being collected: a first
		// render downloads the headless shell for about a minute, and collected
		// output would make that look like a hang.
		const result = yield* run(
			"bun",
			["--install=fallback", "run", childPath, payload],
			{ cwd: dir, stdout: "ignore", stderr: "inherit" },
		);
		if (result.code !== 0) {
			return yield* Effect.fail(
				new RenderError({ reason: "Render failed; see the output above." }),
			);
		}
		return request.outputPath;
	});

/**
 * Reuses one Chrome Headless Shell across video renders.
 *
 * Remotion downloads a version-pinned browser into `node_modules/.remotion`,
 * which would mean a fresh ~190 MB download for every render out of a temp
 * directory. Symlinking a shared cache in makes it a one-time cost. The temp
 * directory's cleanup unlinks the symlink without following it — verified, as
 * following it would delete the shared download on every render.
 */
const linkBrowserCache = (
	dir: string,
): Effect.Effect<void, RenderError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const cache = join(cacheDir(), "remotion");
		const link = join(dir, "node_modules", ".remotion");
		yield* fs.makeDirectory(cache, { recursive: true });
		yield* fs.makeDirectory(dirname(link), { recursive: true });
		yield* fs.symlink(cache, link);
	}).pipe(
		Effect.mapError(
			(cause) =>
				new RenderError({
					reason: `Could not prepare the browser cache: ${cause.message}`,
				}),
		),
	);

/**
 * The readable part of a failed `Bun.build`.
 *
 * It throws an `AggregateError` whose message is only "Bundle failed"; the
 * actual problems — an unresolved import, a syntax error — are its `errors`.
 */
const buildFailure = (cause: unknown): string =>
	cause instanceof AggregateError && cause.errors.length > 0
		? cause.errors.map(String).join("\n")
		: String(cause);

/** Above this, an embedded file is worth a warning: base64 grows it by a third. */
const LARGE_ASSET_BYTES = 5 * 1024 * 1024;

const isFile = (path: string): boolean =>
	statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * Embeds files under `--assets` that the composition names, as data URIs.
 *
 * A string is treated as an asset when it names a file that exists in the
 * asset directory — the same rule `fal` uses to decide what to upload
 * (ADR 8). Both the composition's string literals and the props are
 * searched, so `<img src="logo.png">` and `{"logo": "logo.png"}` both work.
 * A path assembled at runtime (`img/${n}.png`) cannot be seen, and is left
 * as a relative URL that will not load.
 */
export const embedAssets = (
	code: string,
	props: unknown,
	assetDir: string,
): Effect.Effect<{ code: string; props: unknown }, RenderError> =>
	Effect.gen(function* () {
		const root = resolve(assetDir);
		const isDirectory =
			statSync(root, { throwIfNoEntry: false })?.isDirectory() ?? false;
		if (!isDirectory) {
			return yield* Effect.fail(
				new RenderError({ reason: `--assets is not a directory: ${root}` }),
			);
		}

		const embedded = new Map<string, number>();
		const cache = new Map<string, string | null>();
		const lookup = (value: string): string | null => {
			const ref = assetRef(value);
			if (ref === null) return null;
			const cached = cache.get(ref);
			if (cached !== undefined) return cached;
			const path = resolve(root, ref);
			let uri: string | null = null;
			// Containment first: `../` must not reach outside the directory.
			if (path.startsWith(`${root}${sep}`) && isFile(path)) {
				const bytes = readFileSync(path);
				uri = dataUri(Bun.file(path).type, bytes);
				embedded.set(ref, bytes.length);
			}
			cache.set(ref, uri);
			return uri;
		};

		const result = yield* Effect.try({
			try: () => ({
				code: replaceStringLiterals(code, lookup),
				props: replaceJsonStrings(props, lookup),
			}),
			catch: (cause) =>
				new RenderError({ reason: `Could not embed assets: ${cause}` }),
		});

		for (const [ref, bytes] of embedded) {
			yield* Console.error(`  embedded ${ref} (${formatBytes(bytes)})`);
			if (bytes > LARGE_ASSET_BYTES) {
				yield* Console.error(
					`  warning: ${ref} is ${formatBytes(bytes)}; embedding grows it by a third.`,
				);
			}
		}
		return result;
	});

/**
 * Bundles the staged page into one HTML file with everything inlined.
 *
 * Bun's standalone mode (`--compile --target=browser`) turns the module
 * script into an inline one, linked CSS into `<style>`, and relative files
 * into data URIs.
 *
 * `--production` must be passed, and alone. Despite the help text, `--compile`
 * does not imply it for a browser target: without it React's development
 * build is inlined and a trivial page weighs 1 MB instead of 216 KB. Adding
 * `--minify` beside it brings the 1 MB build back, so do not.
 *
 * It runs as a separate `bun build`, not `Bun.build` in this process. Bun's
 * resolver caches a directory's lack of `node_modules` for the life of the
 * process, so after the flatten pass has looked inside the staged directory —
 * as it does for a composition read from stdin — packages installed there
 * afterwards still fail with `Could not resolve: "react"`.
 */
const buildStandalone = (
	dir: string,
	indexPath: string,
): Effect.Effect<string, Failure, Platform> =>
	Effect.gen(function* () {
		const outdir = join(dir, "dist");
		const result = yield* run(
			"bun",
			[
				"build",
				indexPath,
				"--compile",
				"--target=browser",
				"--production",
				`--outdir=${outdir}`,
			],
			{ cwd: dir },
		);
		if (result.code !== 0) {
			return yield* Effect.fail(
				new RenderError({
					reason: `Could not bundle the page:\n${`${result.stdout}\n${result.stderr}`.trim()}`,
				}),
			);
		}
		return yield* readFile(join(outdir, "index.html"));
	});

const make = (platform: Context.Context<Platform>): RenderShape => {
	/**
	 * Every render runs in its own scope: its temp directory is removed and any
	 * child process killed when it ends, however it ends. Staging errors become
	 * render errors, and the platform services the layer captured are supplied.
	 */
	const finish = <A>(
		effect: Effect.Effect<A, Failure, Platform | Scope.Scope>,
	): Effect.Effect<A, RenderError> =>
		effect.pipe(
			Effect.scoped,
			Effect.mapError(asRenderError),
			Effect.provideContext(platform),
		);

	return {
		toImage: Effect.fn("Render.toImage")(function* (request: ImageRequest) {
			yield* Console.error("Rendering image...");
			return yield* runChild(request, {
				kind: "image",
				width: request.width,
				height: request.height,
				fullPage: request.fullPage,
				deviceScaleFactor: request.deviceScaleFactor,
				transparent: request.transparent,
				quality: request.quality,
			});
		}, finish),

		toPdf: Effect.fn("Render.toPdf")(function* (request: PdfRequest) {
			yield* Console.error("Rendering PDF...");
			return yield* runChild(request, {
				kind: "pdf",
				paperFormat: request.paperFormat,
				pageWidth: request.pageWidth,
				pageHeight: request.pageHeight,
				margin: request.margin,
				landscape: request.landscape,
				scale: request.scale,
			});
		}, finish),

		toHtml: Effect.fn("Render.toHtml")(function* (request: HtmlRequest) {
			yield* Console.error("Rendering HTML...");
			const dir = yield* tempDir("infer-render-");
			const isolated = yield* isolateComposition(request.source, dir, {
				target: "browser",
				productionJsx: true,
				inlineImports: true,
			});
			const flattened = yield* readFile(isolated.path);
			if (!hasDefaultExport(flattened)) {
				return yield* Effect.fail(
					new RenderError({
						reason:
							"The composition must have a default export that is a component.",
					}),
				);
			}

			const { code, props } =
				request.assetDir === undefined
					? { code: flattened, props: request.props }
					: yield* embedAssets(flattened, request.props, request.assetDir);
			yield* writeFile(isolated.path, code);

			// The standalone build resolves from the filesystem, so the page's
			// packages are installed for real.
			yield* install(dir, [
				...new Set([
					...HTML_CORE_DEPS,
					...bareImports(code),
					...(request.tailwind ? [TAILWIND_PACKAGE] : []),
				]),
			]);

			yield* writeFile(join(dir, "entry.ts"), ENTRY_SOURCE);
			const indexPath = join(dir, "index.html");
			yield* writeFile(
				indexPath,
				htmlDocument({
					title: request.title,
					props,
					head: request.head,
					stylesheet: isolated.css,
				}),
			);

			const page = yield* buildStandalone(dir, indexPath);
			// Added after the build rather than handed to it, so the bundler never
			// parses 280 KB of someone else's minified script.
			const html = request.tailwind
				? prependToHead(
						page,
						inlineScript(yield* readFile(Bun.resolveSync(TAILWIND_NAME, dir))),
					)
				: page;
			yield* writeFile(request.outputPath, html);
			return request.outputPath;
		}, finish),

		toVideo: Effect.fn("Render.toVideo")(function* (request: VideoRequest) {
			const dir = yield* tempDir("infer-render-");
			// Remotion's <Img> retries a missing file for ~20s, then fails the
			// whole render, so an import left as a path is fatal here.
			const { path: flattened } = yield* isolateComposition(
				request.source,
				dir,
				{ productionJsx: true, inlineImports: true },
			);
			const code = yield* readFile(flattened);

			yield* writeFile(join(dir, "package.json"), PACKAGE_JSON_SOURCE);
			yield* writeFile(join(dir, "tsconfig.json"), TSCONFIG_SOURCE);
			yield* writeFile(join(dir, "Root.tsx"), ROOT_SOURCE);
			yield* writeFile(join(dir, "index.ts"), INDEX_SOURCE);
			yield* writeFile(
				join(dir, "config.json"),
				JSON.stringify({
					dimensions: request.dimensions,
					props: request.props ?? {},
				}),
			);

			yield* linkBrowserCache(dir);
			// The flattened bundle's remaining bare specifiers *are* the external
			// dependencies, which beats guessing them from the original source.
			yield* install(dir, [
				...new Set([...VIDEO_CORE_DEPS, ...bareImports(code)]),
			]);

			const childPath = join(dir, "render-video-child.mjs");
			yield* writeFile(childPath, VIDEO_CHILD_SOURCE);
			const fs = yield* FileSystem.FileSystem;
			yield* fs
				.makeDirectory(dirname(request.outputPath), { recursive: true })
				.pipe(
					Effect.mapError(
						(cause) =>
							new RenderError({
								reason: `Could not create ${dirname(request.outputPath)}: ${cause.message}`,
							}),
					),
				);

			const payload = JSON.stringify({
				entryPoint: join(dir, "index.ts"),
				outputPath: request.outputPath,
				publicDir: request.assetDir ? resolve(request.assetDir) : null,
				props: request.props ?? {},
				codec: request.codec,
				concurrency: request.concurrency,
				crf: request.crf,
				scale: request.scale,
				frameRange: request.frameRange,
				muted: request.muted,
				frame: request.frame,
				stillFormat: request.stillFormat,
			});
			// stdout is discarded rather than piped: an unread pipe fills and blocks
			// the child once Remotion has logged enough to it.
			const result = yield* run("bun", ["run", childPath, payload], {
				cwd: dir,
				stdout: "ignore",
				stderr: "inherit",
			});
			if (result.code !== 0) {
				return yield* Effect.fail(
					new RenderError({
						reason: "Video render failed; see the output above.",
					}),
				);
			}
			return request.outputPath;
		}, finish),
	};
};

/** Built against the platform services, so its methods need nothing more. */
export const layer: Layer.Layer<Render, never, Platform> = Layer.effect(Render)(
	Effect.gen(function* () {
		return make(yield* Effect.context<Platform>());
	}),
);
