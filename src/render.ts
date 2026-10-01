/**
 * Rendering TSX compositions to images and PDFs.
 *
 * The composition is flattened with `Bun.build`, staged in an isolated temp
 * directory, and handed to a `bun --install=fallback` child that owns the
 * whole render. React, Playwright and anything the composition imports are
 * resolved on demand from Bun's cache, so none of them are dependencies of
 * this CLI. See `docs/adrs/0012`.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Console, Context, Data, Effect, Layer } from "effect";
import { inlineScript } from "./html.ts";
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

const withTempDir = <A, E>(
	use: (dir: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | RenderError> =>
	Effect.acquireUseRelease(
		Effect.try({
			try: () => mkdtempSync(join(tmpdir(), "infer-render-")),
			catch: (cause) =>
				new RenderError({
					reason: `Could not create a temp directory: ${cause}`,
				}),
		}),
		use,
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);

const write = (path: string, contents: string) =>
	Effect.tryPromise({
		try: () => Bun.write(path, contents),
		catch: (cause) =>
			new RenderError({ reason: `Could not write ${path}: ${cause}` }),
	});

/**
 * Flattens the composition and its relative imports into one self-contained
 * file inside `dir`.
 *
 * Package imports stay bare so the child installs them on demand; relative
 * imports are inlined, which is what lets the file leave its own project. The
 * temp directory has no `node_modules` above it, so a render cannot pick up
 * anything from wherever the composition happened to live.
 */
interface IsolateOptions {
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
}

interface Isolated {
	readonly path: string;
	/** Whether the composition imported CSS, written beside it as `composition.css`. */
	readonly css: boolean;
}

const isolateComposition = (
	source: CompositionSource,
	dir: string,
	options: IsolateOptions = {},
): Effect.Effect<Isolated, RenderError> =>
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
				yield* write(inlinePath, source.inline);
				return inlinePath;
			}
			const path = resolve(source.path as string);
			const exists = yield* Effect.tryPromise({
				try: () => Bun.file(path).exists(),
				catch: () => new RenderError({ reason: `Could not read ${path}` }),
			});
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
		const isolated = join(dir, "composition.tsx");
		yield* write(isolated, code);

		const stylesheets = built.outputs.filter((output) =>
			output.path.endsWith(".css"),
		);
		if (stylesheets.length > 0) {
			const css = yield* Effect.forEach(stylesheets, read);
			yield* write(join(dir, "composition.css"), css.join("\n"));
		}
		return { path: isolated, css: stylesheets.length > 0 };
	});

/** Stages the worker and runs it, returning the path it wrote. */
const runChild = (
	request: RenderRequest,
	job: Record<string, unknown>,
): Effect.Effect<string, RenderError> =>
	withTempDir((dir) =>
		Effect.gen(function* () {
			const { path: compositionPath } = yield* isolateComposition(
				request.source,
				dir,
			);
			yield* write(join(dir, "render-shared.ts"), SHARED_SOURCE);
			const childPath = join(dir, "render-child.ts");
			yield* write(childPath, CHILD_SOURCE);

			const payload = JSON.stringify({
				...job,
				compositionPath,
				props: request.props ?? {},
				outputPath: request.outputPath,
				assetDir: request.assetDir,
				head: request.head,
				tailwindPackage: request.tailwind ? TAILWIND_PACKAGE : undefined,
				waitUntil: request.waitUntil,
			});

			const result = yield* Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(
						["bun", "--install=fallback", "run", childPath, payload],
						{ cwd: dir, stdout: "pipe", stderr: "pipe" },
					);
					const [stderr, code] = await Promise.all([
						new Response(proc.stderr).text(),
						proc.exited,
					]);
					return { stderr, code };
				},
				catch: (cause) =>
					new RenderError({ reason: `Could not run the renderer: ${cause}` }),
			});

			if (result.code !== 0) {
				return yield* Effect.fail(
					new RenderError({
						reason: `Render failed:\n${result.stderr.trim()}`,
					}),
				);
			}
			return request.outputPath;
		}),
	);

/**
 * Installs the packages a video render needs into the staged directory.
 *
 * Unlike the image path, this cannot rely on `--install=fallback`: Remotion
 * bundles with Rspack, which resolves modules from the filesystem and cannot
 * see anything Bun resolved in-process. Warm installs come from Bun's global
 * cache in well under a second.
 */
const installDeps = (
	dir: string,
	deps: ReadonlyArray<string>,
): Effect.Effect<void, RenderError> =>
	Effect.gen(function* () {
		yield* Console.error(`Installing ${deps.length} packages...`);
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
				new RenderError({ reason: `Could not install dependencies: ${cause}` }),
		});
		if (result.code !== 0) {
			return yield* Effect.fail(
				new RenderError({
					reason: `Could not install dependencies:\n${result.stderr.trim()}`,
				}),
			);
		}
	});

/**
 * Reuses one Chrome Headless Shell across renders.
 *
 * Remotion downloads a version-pinned browser into `node_modules/.remotion`,
 * which would mean a fresh ~150MB download for every render out of a temp
 * directory. Symlinking a shared cache in makes it a one-time cost.
 */
const linkBrowserCache = (dir: string): Effect.Effect<void, RenderError> =>
	Effect.try({
		try: () => {
			const cache = join(
				process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
				"infer",
				"remotion",
			);
			mkdirSync(cache, { recursive: true });
			mkdirSync(join(dir, "node_modules"), { recursive: true });
			const link = join(dir, "node_modules", ".remotion");
			rmSync(link, { recursive: true, force: true });
			symlinkSync(cache, link);
		},
		catch: (cause) =>
			new RenderError({
				reason: `Could not prepare the browser cache: ${cause}`,
			}),
	});

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

const readText = (path: string): Effect.Effect<string, RenderError> =>
	Effect.tryPromise({
		try: async () => Bun.file(path).text(),
		catch: (cause) =>
			new RenderError({ reason: `Could not read ${path}: ${cause}` }),
	});

const formatBytes = (bytes: number): string =>
	bytes < 1024 * 1024
		? `${(bytes / 1024).toFixed(1)} KB`
		: `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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
): Effect.Effect<string, RenderError> =>
	Effect.gen(function* () {
		const outdir = join(dir, "dist");
		const result = yield* Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(
					[
						"bun",
						"build",
						indexPath,
						"--compile",
						"--target=browser",
						"--production",
						`--outdir=${outdir}`,
					],
					{ cwd: dir, stdout: "pipe", stderr: "pipe" },
				);
				const [stdout, stderr, code] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return { output: `${stdout}\n${stderr}`.trim(), code };
			},
			catch: (cause) =>
				new RenderError({ reason: `Could not run the bundler: ${cause}` }),
		});
		if (result.code !== 0) {
			return yield* Effect.fail(
				new RenderError({
					reason: `Could not bundle the page:\n${result.output}`,
				}),
			);
		}
		return yield* readText(join(outdir, "index.html"));
	});

const make = (): RenderShape => ({
	toImage: (request) =>
		Effect.gen(function* () {
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
		}),

	toPdf: (request) =>
		Effect.gen(function* () {
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
		}),

	toHtml: (request) =>
		withTempDir((dir) =>
			Effect.gen(function* () {
				yield* Console.error("Rendering HTML...");
				const isolated = yield* isolateComposition(request.source, dir, {
					target: "browser",
					productionJsx: true,
					inlineImports: true,
				});
				const flattened = yield* readText(isolated.path);
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
				yield* write(isolated.path, code);

				// Bun.build resolves from the filesystem, so the page's packages are
				// installed for real — auto-install would be invisible to it.
				const deps = [
					...new Set([
						...HTML_CORE_DEPS,
						...bareImports(code),
						...(request.tailwind ? [TAILWIND_PACKAGE] : []),
					]),
				];
				yield* write(
					join(dir, "package.json"),
					JSON.stringify({ name: "infer-html", private: true }),
				);
				yield* installDeps(dir, deps);

				yield* write(join(dir, "entry.ts"), ENTRY_SOURCE);
				const indexPath = join(dir, "index.html");
				yield* write(
					indexPath,
					htmlDocument({
						title: request.title,
						props,
						head: request.head,
						stylesheet: isolated.css,
					}),
				);

				const page = yield* buildStandalone(dir, indexPath);
				// Added after the build rather than handed to it, so the bundler
				// never parses 280 KB of someone else's minified script.
				const html = request.tailwind
					? prependToHead(
							page,
							inlineScript(
								yield* Effect.tryPromise({
									try: async () =>
										Bun.file(Bun.resolveSync(TAILWIND_NAME, dir)).text(),
									catch: (cause) =>
										new RenderError({
											reason: `Could not load Tailwind: ${cause}`,
										}),
								}),
							),
						)
					: page;

				yield* Effect.try({
					try: () =>
						mkdirSync(dirname(request.outputPath), { recursive: true }),
					catch: (cause) =>
						new RenderError({
							reason: `Could not create ${dirname(request.outputPath)}: ${cause}`,
						}),
				});
				yield* write(request.outputPath, html);
				return request.outputPath;
			}),
		),

	toVideo: (request) =>
		withTempDir((dir) =>
			Effect.gen(function* () {
				const { path: flattened } = yield* isolateComposition(
					request.source,
					dir,
					{ productionJsx: true },
				);
				const code = yield* Effect.tryPromise({
					try: () => Bun.file(flattened).text(),
					catch: (cause) =>
						new RenderError({ reason: `Could not read the bundle: ${cause}` }),
				});

				// The flattened bundle's remaining bare specifiers *are* the external
				// dependencies, which beats guessing them from the original source.
				const deps = [...new Set([...VIDEO_CORE_DEPS, ...bareImports(code)])];

				yield* write(join(dir, "package.json"), PACKAGE_JSON_SOURCE);
				yield* write(join(dir, "tsconfig.json"), TSCONFIG_SOURCE);
				yield* write(join(dir, "Root.tsx"), ROOT_SOURCE);
				yield* write(join(dir, "index.ts"), INDEX_SOURCE);
				yield* write(
					join(dir, "config.json"),
					JSON.stringify({
						dimensions: request.dimensions,
						props: request.props ?? {},
					}),
				);

				yield* linkBrowserCache(dir);
				yield* installDeps(dir, deps);

				const childPath = join(dir, "render-video-child.mjs");
				yield* write(childPath, VIDEO_CHILD_SOURCE);

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

				yield* Effect.sync(() =>
					mkdirSync(dirname(request.outputPath), { recursive: true }),
				);

				const result = yield* Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn(["bun", "run", childPath, payload], {
							cwd: dir,
							stdout: "pipe",
							stderr: "inherit",
						});
						return await proc.exited;
					},
					catch: (cause) =>
						new RenderError({ reason: `Could not run the renderer: ${cause}` }),
				});

				if (result !== 0) {
					return yield* Effect.fail(
						new RenderError({
							reason: "Video render failed; see the output above.",
						}),
					);
				}
				return request.outputPath;
			}),
		),
});

export const layer: Layer.Layer<Render> = Layer.sync(Render)(make);
