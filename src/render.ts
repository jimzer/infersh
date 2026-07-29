/**
 * Rendering TSX compositions to images and PDFs.
 *
 * The composition is flattened with `Bun.build`, staged in an isolated temp
 * directory, and handed to a `bun --install=fallback` child that owns the
 * whole render. React, Playwright and anything the composition imports are
 * resolved on demand from Bun's cache, so none of them are dependencies of
 * this CLI. See `docs/adrs/0012`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Console, Context, Data, Effect, Layer } from "effect";
// Embedded as text: the bundler copies the characters and never follows the
// imports inside, which is what keeps React and Playwright out of the bundle.
// Once a module is imported this way it is text for the whole build, so these
// two files must never be imported normally from here — consumers that need
// their values import `render-shared.ts` directly.
// @ts-expect-error text import: Bun inlines the file contents as a string
import childSource from "./render-child.ts" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import sharedSource from "./render-shared.ts" with { type: "text" };

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

export interface RenderShape {
	readonly toImage: (
		request: ImageRequest,
	) => Effect.Effect<string, RenderError>;
	readonly toPdf: (request: PdfRequest) => Effect.Effect<string, RenderError>;
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
const isolateComposition = (
	source: CompositionSource,
	dir: string,
): Effect.Effect<string, RenderError> =>
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
					target: "bun",
					packages: "external",
				}),
			catch: (cause) =>
				new RenderError({
					reason: `Could not bundle the composition: ${cause}`,
				}),
		});
		if (!built.success || built.outputs[0] === undefined) {
			return yield* Effect.fail(
				new RenderError({
					reason: `Could not bundle the composition:\n${built.logs.map(String).join("\n")}`,
				}),
			);
		}
		const code = yield* Effect.tryPromise({
			try: () => built.outputs[0]?.text() as Promise<string>,
			catch: (cause) =>
				new RenderError({ reason: `Could not read the bundle: ${cause}` }),
		});

		const isolated = join(dir, "composition.tsx");
		yield* write(isolated, code);
		return isolated;
	});

/** Stages the worker and runs it, returning the path it wrote. */
const runChild = (
	request: RenderRequest,
	job: Record<string, unknown>,
): Effect.Effect<string, RenderError> =>
	withTempDir((dir) =>
		Effect.gen(function* () {
			const compositionPath = yield* isolateComposition(request.source, dir);
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
				tailwind: request.tailwind,
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
});

export const layer: Layer.Layer<Render> = Layer.sync(Render)(make);
