/**
 * Rendering TSX compositions to images and PDFs.
 *
 * The composition is flattened with `Bun.build`, copied into an isolated temp
 * directory, and rendered to HTML by a short-lived `bun --install=fallback`
 * child. Playwright then turns that HTML into an image or a PDF, serving any
 * local assets through request interception rather than an HTTP server.
 *
 * See `docs/adrs/0012`.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { Console, Context, Data, Effect, Layer } from "effect";

export class RenderError extends Data.TaggedError("RenderError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

/**
 * The origin that local assets are served from.
 *
 * A composition references assets relatively (`img/logo.png`); a `<base>` tag
 * turns those into absolute URLs on this host, which never resolves over the
 * network because every request to it is intercepted.
 */
export const ASSET_ORIGIN = "http://assets.infer.local";

/**
 * The renderer that runs in the child process.
 *
 * Embedded as a string on purpose: the bundler treats it as data, so React
 * never enters our bundle and the child resolves it at runtime instead. The
 * composition path and props arrive as argv, so nothing user-supplied is ever
 * concatenated into source.
 */
const CHILD_SOURCE = `
const [compPath, propsJson] = process.argv.slice(2);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const mod = await import(compPath);
const Component = mod.default;
if (typeof Component !== "function") {
	console.error("The composition must have a default export that is a component.");
	process.exit(1);
}
process.stdout.write(
	renderToStaticMarkup(createElement(Component, JSON.parse(propsJson || "{}"))),
);
`;

export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const WAIT_EVENTS = ["load", "domcontentloaded", "networkidle"] as const;

export const PAPER_FORMATS = [
	"a4",
	"a3",
	"a5",
	"letter",
	"legal",
	"tabloid",
] as const;

/** Picks the image format from the output extension. */
export const formatFromPath = (path: string): ImageFormat => {
	const ext = extname(path).slice(1).toLowerCase();
	if (ext === "jpg" || ext === "jpeg") return "jpeg";
	if (ext === "webp") return "webp";
	return "png";
};

/** Wraps rendered markup in a document, pointing assets at the intercepted origin. */
export const buildHtml = (options: {
	readonly markup: string;
	readonly head?: string;
	readonly tailwind: boolean;
	readonly transparent: boolean;
}): string => {
	const parts = [
		`<base href="${ASSET_ORIGIN}/">`,
		// Chrome's default 8px body margin would show as a border on a captured
		// composition, so it is always reset.
		"<style>html,body{margin:0;padding:0}</style>",
	];
	if (options.tailwind) {
		parts.push('<script src="https://cdn.tailwindcss.com"></script>');
	}
	if (options.transparent) {
		parts.push("<style>html,body{background:transparent !important}</style>");
	}
	if (options.head) parts.push(options.head);

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${parts.join("\n")}
</head>
<body>
${options.markup}
</body>
</html>`;
};

/**
 * Maps an intercepted URL to a file inside the asset directory.
 *
 * Returns null when the path escapes the directory, so a composition cannot
 * read arbitrary files by asking for `../../etc/passwd`.
 */
export const assetPathFor = (url: string, assetDir: string): string | null => {
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(url).pathname);
	} catch {
		return null;
	}
	const root = resolve(assetDir);
	const target = resolve(join(root, pathname));
	if (target !== root && !target.startsWith(`${root}/`)) return null;
	return target;
};

export interface CompositionSource {
	/** Path to a `.tsx` file, or undefined when reading stdin. */
	readonly path?: string;
	/** Composition source passed directly. */
	readonly inline?: string;
}

export interface RenderRequest {
	readonly source: CompositionSource;
	readonly props: unknown;
	readonly assetDir?: string;
	readonly head?: string;
	readonly tailwind: boolean;
	readonly waitUntil: string;
	readonly outputPath: string;
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
	readonly width?: string;
	readonly height?: string;
	readonly margin: {
		readonly top: string;
		readonly right: string;
		readonly bottom: string;
		readonly left: string;
	};
	readonly landscape: boolean;
	readonly scale: number;
}

export interface RenderShape {
	/** Render a composition to HTML, without touching a browser. */
	readonly toHtml: (
		request: RenderRequest,
	) => Effect.Effect<string, RenderError>;
	readonly toImage: (
		request: ImageRequest,
	) => Effect.Effect<string, RenderError>;
	readonly toPdf: (request: PdfRequest) => Effect.Effect<string, RenderError>;
}

export class Render extends Context.Service<Render, RenderShape>()("Render") {}

// --- Implementation -------------------------------------------------------

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

/**
 * Flattens the composition and its relative imports into one self-contained
 * file inside `dir`.
 *
 * Bare imports are left alone so the child auto-installs them; relative
 * imports are inlined, which is what lets the file leave its project.
 */
const isolateComposition = (
	source: CompositionSource,
	dir: string,
): Effect.Effect<string, RenderError> =>
	Effect.gen(function* () {
		const entry = yield* Effect.gen(function* () {
			if (source.inline !== undefined) {
				// Inline source has no directory, so relative imports cannot resolve.
				if (/from\s*["']\.\.?\//.test(source.inline)) {
					return yield* Effect.fail(
						new RenderError({
							reason:
								"An inline composition cannot use relative imports, because there is no directory to resolve them against.\nPass a file path instead.",
						}),
					);
				}
				const inlinePath = join(dir, "inline.tsx");
				yield* Effect.tryPromise({
					try: () => Bun.write(inlinePath, source.inline as string),
					catch: (cause) =>
						new RenderError({
							reason: `Could not stage the composition: ${cause}`,
						}),
				});
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
					target: "bun",
					// Keep every package import bare so the child resolves them.
					packages: "external",
				}),
			catch: (cause) =>
				new RenderError({
					reason: `Could not bundle the composition: ${cause}`,
				}),
		});

		if (!built.success || built.outputs[0] === undefined) {
			const logs = built.logs.map((l) => String(l)).join("\n");
			return yield* Effect.fail(
				new RenderError({
					reason: `Could not bundle the composition:\n${logs}`,
				}),
			);
		}

		const code = yield* Effect.tryPromise({
			try: () => built.outputs[0]?.text() as Promise<string>,
			catch: (cause) =>
				new RenderError({ reason: `Could not read the bundle: ${cause}` }),
		});

		// The isolated copy sits in a directory with no node_modules above it, so
		// nothing from the composition's own project can leak in.
		const isolated = join(dir, "composition.tsx");
		yield* Effect.tryPromise({
			try: () => Bun.write(isolated, code),
			catch: (cause) =>
				new RenderError({ reason: `Could not stage the bundle: ${cause}` }),
		});
		return isolated;
	});

/** Runs the child renderer and returns the markup it wrote to stdout. */
const renderMarkup = (
	compositionPath: string,
	props: unknown,
	dir: string,
): Effect.Effect<string, RenderError> =>
	Effect.gen(function* () {
		const childPath = join(dir, "render-child.tsx");
		yield* Effect.tryPromise({
			try: () => Bun.write(childPath, CHILD_SOURCE),
			catch: (cause) =>
				new RenderError({ reason: `Could not stage the renderer: ${cause}` }),
		});

		const result = yield* Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(
					[
						"bun",
						// Dependencies the composition imports are installed on demand
						// from Bun's global cache, so no project setup is needed.
						"--install=fallback",
						"run",
						childPath,
						compositionPath,
						JSON.stringify(props ?? {}),
					],
					{ cwd: dir, stdout: "pipe", stderr: "pipe" },
				);
				const [stdout, stderr, code] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return { stdout, stderr, code };
			},
			catch: (cause) =>
				new RenderError({ reason: `Could not run the renderer: ${cause}` }),
		});

		if (result.code !== 0) {
			return yield* Effect.fail(
				new RenderError({
					reason: `The composition failed to render:\n${result.stderr.trim()}`,
				}),
			);
		}
		if (result.stdout.trim() === "") {
			return yield* Effect.fail(
				new RenderError({
					reason:
						"The composition rendered nothing. Does its default export return markup?",
				}),
			);
		}
		return result.stdout;
	});

/** Chrome locations tried in order when no explicit path is given. */
const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

const LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--no-first-run",
];

const launchBrowser = Effect.gen(function* () {
	const { chromium } = yield* Effect.tryPromise({
		try: () => import("playwright-core"),
		catch: (cause) =>
			new RenderError({ reason: `Could not load playwright-core: ${cause}` }),
	});

	const attempts: Array<{ label: string; options: Record<string, unknown> }> = [
		{ label: "system Chrome", options: { channel: "chrome" } },
	];
	if (process.env.CHROME_PATH) {
		attempts.unshift({
			label: `CHROME_PATH (${process.env.CHROME_PATH})`,
			options: { executablePath: process.env.CHROME_PATH },
		});
	}
	for (const path of CHROME_CANDIDATES) {
		attempts.push({ label: path, options: { executablePath: path } });
	}

	const failures: string[] = [];
	for (const attempt of attempts) {
		const browser = yield* Effect.tryPromise({
			try: () =>
				chromium.launch({
					headless: true,
					args: LAUNCH_ARGS,
					...attempt.options,
				}),
			catch: (cause) => new RenderError({ reason: `${cause}` }),
		}).pipe(Effect.option);
		if (browser._tag === "Some") return browser.value;
		failures.push(attempt.label);
	}

	return yield* Effect.fail(
		new RenderError({
			reason: `No Chrome or Chromium could be launched. Tried: ${failures.join(", ")}.\nInstall Google Chrome, or set CHROME_PATH to an executable.`,
		}),
	);
});

/**
 * Opens a page showing the rendered markup.
 *
 * Local assets are served by intercepting requests to the asset origin, so no
 * HTTP server is started, no port is bound, and the asset directory is read in
 * place rather than copied.
 */
const withPage = <A>(
	html: string,
	request: RenderRequest,
	viewport: { width: number; height: number; deviceScaleFactor: number },
	use: (page: import("playwright-core").Page) => Promise<A>,
): Effect.Effect<A, RenderError> =>
	Effect.gen(function* () {
		const browser = yield* launchBrowser;
		return yield* Effect.tryPromise({
			try: async () => {
				try {
					const context = await browser.newContext({
						viewport: { width: viewport.width, height: viewport.height },
						deviceScaleFactor: viewport.deviceScaleFactor,
					});
					const page = await context.newPage();

					await page.route(`${ASSET_ORIGIN}/**`, async (route) => {
						if (request.assetDir === undefined) {
							return route.fulfill({ status: 404, body: "no asset directory" });
						}
						const path = assetPathFor(route.request().url(), request.assetDir);
						if (path === null) {
							return route.fulfill({ status: 403, body: "outside asset dir" });
						}
						const file = Bun.file(path);
						if (!(await file.exists())) {
							return route.fulfill({ status: 404, body: "not found" });
						}
						return route.fulfill({
							status: 200,
							contentType: file.type,
							body: Buffer.from(await file.arrayBuffer()),
						});
					});

					await page.setContent(html, {
						waitUntil: request.waitUntil as "load",
					});
					return await use(page);
				} finally {
					await browser.close();
				}
			},
			catch: (cause) =>
				new RenderError({ reason: `Rendering failed: ${cause}` }),
		});
	});

const ensureParent = (path: string) =>
	Effect.try({
		try: () => mkdirSync(dirname(path), { recursive: true }),
		catch: (cause) =>
			new RenderError({
				reason: `Could not create the output directory: ${cause}`,
			}),
	});

const make = (): RenderShape => {
	const toHtml: RenderShape["toHtml"] = (request) =>
		withTempDir((dir) =>
			Effect.gen(function* () {
				const composition = yield* isolateComposition(request.source, dir);
				const markup = yield* renderMarkup(composition, request.props, dir);
				return buildHtml({
					markup,
					head: request.head,
					tailwind: request.tailwind,
					transparent: false,
				});
			}),
		);

	return {
		toHtml,

		toImage: (request) =>
			withTempDir((dir) =>
				Effect.gen(function* () {
					const composition = yield* isolateComposition(request.source, dir);
					const markup = yield* renderMarkup(composition, request.props, dir);
					const html = buildHtml({
						markup,
						head: request.head,
						tailwind: request.tailwind,
						transparent: request.transparent,
					});
					yield* ensureParent(request.outputPath);
					const format = formatFromPath(request.outputPath);
					yield* Console.error("Capturing image...");
					yield* withPage(
						html,
						request,
						{
							width: request.width,
							height: request.height ?? 720,
							deviceScaleFactor: request.deviceScaleFactor,
						},
						async (page) => {
							// With no explicit height, shrink the viewport to the content
							// so the image hugs it instead of padding out to 720px.
							if (request.height === undefined) {
								// Passed as a string so this file needs no DOM lib types.
								const contentHeight = Number(
									await page.evaluate("document.body.scrollHeight"),
								);
								if (Number.isFinite(contentHeight) && contentHeight > 0) {
									await page.setViewportSize({
										width: request.width,
										height: contentHeight,
									});
								}
							}
							return page.screenshot({
								path: request.outputPath,
								fullPage: request.fullPage,
								type: format,
								omitBackground: request.transparent,
								...(format === "jpeg" && request.quality !== undefined
									? { quality: request.quality }
									: {}),
							});
						},
					);
					return request.outputPath;
				}),
			),

		toPdf: (request) =>
			withTempDir((dir) =>
				Effect.gen(function* () {
					const composition = yield* isolateComposition(request.source, dir);
					const markup = yield* renderMarkup(composition, request.props, dir);
					const html = buildHtml({
						markup,
						head: request.head,
						tailwind: request.tailwind,
						transparent: false,
					});
					yield* ensureParent(request.outputPath);
					yield* Console.error("Generating PDF...");
					yield* withPage(
						html,
						request,
						{ width: 1280, height: 720, deviceScaleFactor: 1 },
						(page) =>
							page.pdf({
								path: request.outputPath,
								...(request.width && request.height
									? { width: request.width, height: request.height }
									: { format: request.paperFormat ?? "a4" }),
								landscape: request.landscape,
								margin: request.margin,
								scale: request.scale,
								printBackground: true,
							}),
					);
					return request.outputPath;
				}),
			),
	};
};

export const layer: Layer.Layer<Render> = Layer.sync(Render)(make);
