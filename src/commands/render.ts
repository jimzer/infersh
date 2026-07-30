/**
 * `infer render` — turn TSX compositions into images and PDFs.
 */

import { resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { emitJson, jsonFlag } from "../output.ts";
import {
	CODECS,
	type CompositionSource,
	PAPER_FORMATS,
	Render,
	RenderError,
	WAIT_EVENTS,
} from "../render.ts";

const COMPOSITION_NOTE =
	"Path to a .tsx file whose default export is a component, or - to read it from stdin. Relative imports of other .tsx files are inlined automatically; package imports are installed on demand.";

const PROPS_NOTE =
	"Props for the component, as inline JSON or a path to a .json file. Available as the component's first argument.";

/**
 * Local copy of the extension-to-format rule.
 *
 * `render-shared.ts` is text-imported by `render.ts`, which makes it text for
 * the whole build, so no module may import values from it (ADR 12).
 */
const imageFormat = (path: string): string =>
	/\.jpe?g$/i.test(path) ? "jpeg" : /\.webp$/i.test(path) ? "webp" : "png";

/** Reads a composition from stdin when the path is `-` or omitted. */
const readStdin = Effect.tryPromise({
	try: async () => {
		const chunks: Uint8Array[] = [];
		for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
		return Buffer.concat(chunks).toString("utf-8");
	},
	catch: (cause) =>
		new RenderError({
			reason: `Could not read the composition from stdin: ${cause}`,
		}),
});

const resolveSource = (
	composition: Option.Option<string>,
): Effect.Effect<CompositionSource, RenderError> =>
	Effect.gen(function* () {
		const path = Option.getOrUndefined(composition);
		if (path !== undefined && path !== "-") return { path };
		const inline = yield* readStdin;
		if (inline.trim() === "") {
			return yield* Effect.fail(
				new RenderError({
					reason:
						"No composition given. Pass a .tsx path, or pipe one in and use -.",
				}),
			);
		}
		return { inline };
	});

/** Accepts inline JSON or a path to a JSON file. */
const resolveProps = (
	data: Option.Option<string>,
): Effect.Effect<unknown, RenderError> =>
	Effect.gen(function* () {
		if (Option.isNone(data)) return {};
		const raw = data.value.trimStart().startsWith("{")
			? data.value
			: yield* Effect.tryPromise({
					try: async () => {
						const file = Bun.file(resolve(data.value));
						if (!(await file.exists())) {
							throw new Error(`file not found: ${data.value}`);
						}
						return file.text();
					},
					catch: (cause) =>
						new RenderError({ reason: `Could not read --props: ${cause}` }),
				});
		return yield* Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: () => new RenderError({ reason: "--props is not valid JSON." }),
		});
	});

const sharedFlags = {
	props: Flag.string("props").pipe(
		Flag.withMetavar("json|path"),
		Flag.optional,
		Flag.withDescription(PROPS_NOTE),
	),
	assets: Flag.string("assets").pipe(
		Flag.withMetavar("dir"),
		Flag.optional,
		Flag.withDescription(
			"Directory holding local images, fonts and other files the composition references by relative URL. Served straight from disk by request interception, so nothing is copied and no server is started.",
		),
	),
	head: Flag.string("head").pipe(
		Flag.withMetavar("html"),
		Flag.optional,
		Flag.withDescription(
			"Extra HTML injected into <head>, e.g. a <style> block or a font <link>.",
		),
	),
	noTailwind: Flag.boolean("no-tailwind").pipe(
		Flag.withDescription(
			"Skip the Tailwind CDN script. Tailwind is injected by default, which requires network access; disable it for fully offline renders.",
		),
	),
	json: jsonFlag,
	wait: Flag.choice("wait", WAIT_EVENTS).pipe(
		Flag.optional,
		Flag.withDescription(
			"How long to wait before capturing: load, domcontentloaded, or networkidle. Defaults to networkidle, which waits for fonts and images to settle.",
		),
	),
};

// --- image ----------------------------------------------------------------

const imageCmd = Command.make(
	"image",
	{
		composition: Argument.string("composition").pipe(
			Argument.optional,
			Argument.withDescription(COMPOSITION_NOTE),
		),
		output: Flag.string("output").pipe(
			Flag.withAlias("o"),
			Flag.withMetavar("path"),
			Flag.optional,
			Flag.withDescription(
				"Where to write the image. The extension picks the format: .png, .jpg or .webp. Defaults to out/image.png.",
			),
		),
		width: Flag.integer("width").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription("Viewport width in pixels. Defaults to 1280."),
		),
		height: Flag.integer("height").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription(
				"Viewport height in pixels. Omit to let the content decide its own height.",
			),
		),
		noFullPage: Flag.boolean("no-full-page").pipe(
			Flag.withDescription(
				"Capture only the viewport instead of the whole scrollable page.",
			),
		),
		scale: Flag.float("scale").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Device pixel ratio. 2 renders at retina resolution, doubling the pixel dimensions. Defaults to 1.",
			),
		),
		quality: Flag.integer("quality").pipe(
			Flag.withMetavar("0-100"),
			Flag.optional,
			Flag.withDescription("JPEG quality. Ignored for png and webp output."),
		),
		transparent: Flag.boolean("transparent").pipe(
			Flag.withDescription(
				"Render with a transparent background instead of white. Only meaningful for png and webp.",
			),
		),
		...sharedFlags,
	},
	(config) =>
		Effect.gen(function* () {
			const render = yield* Render;
			const source = yield* resolveSource(config.composition);
			const props = yield* resolveProps(config.props);
			const output = Option.getOrElse(config.output, () => "out/image.png");

			const written = yield* render.toImage({
				source,
				props,
				assetDir: Option.getOrUndefined(config.assets),
				head: Option.getOrUndefined(config.head),
				tailwind: !config.noTailwind,
				waitUntil: Option.getOrElse(config.wait, () => "networkidle"),
				outputPath: resolve(output),
				width: Option.getOrElse(config.width, () => 1280),
				height: Option.getOrUndefined(config.height),
				fullPage: !config.noFullPage,
				deviceScaleFactor: Option.getOrElse(config.scale, () => 1),
				transparent: config.transparent,
				quality: Option.getOrUndefined(config.quality),
			});
			if (config.json) {
				return yield* emitJson({
					output: written,
					kind: "image",
					format: imageFormat(written),
					width: Option.getOrElse(config.width, () => 1280),
					height: Option.getOrUndefined(config.height) ?? null,
					scale: Option.getOrElse(config.scale, () => 1),
				});
			}
			yield* Console.log(written);
		}),
).pipe(
	Command.withShortDescription("Render a composition to an image."),
	Command.withDescription(
		`Render a TSX composition to a PNG, JPEG or WebP.

The component is rendered to static HTML, then captured with a headless
Chrome. Only the written path goes to stdout, so it pipes cleanly.

Package imports inside the composition are installed on demand from
Bun's cache, so a composition can use any npm library without any
project setup. It renders in isolation and never picks up dependencies
from the surrounding directory.

Requires Google Chrome or Chromium; set CHROME_PATH to choose one.`,
	),
	Command.withExamples([
		{
			command: "infer render image card.tsx -o card.png",
			description: "Render a composition to a PNG",
		},
		{
			command: `infer render image card.tsx --props '{"title":"Hello"}'`,
			description: "Pass props to the component",
		},
		{
			command: "infer render image card.tsx --width 1200 --scale 2",
			description: "Render at retina resolution",
		},
		{
			command: "infer render image card.tsx --assets ./public",
			description: "Let the composition reference local images",
		},
		{
			command: "cat card.tsx | infer render image - -o card.png",
			description: "Read the composition from stdin",
		},
	]),
);

// --- pdf ------------------------------------------------------------------

const pdfCmd = Command.make(
	"pdf",
	{
		composition: Argument.string("composition").pipe(
			Argument.optional,
			Argument.withDescription(COMPOSITION_NOTE),
		),
		output: Flag.string("output").pipe(
			Flag.withAlias("o"),
			Flag.withMetavar("path"),
			Flag.optional,
			Flag.withDescription(
				"Where to write the PDF. Defaults to out/document.pdf.",
			),
		),
		format: Flag.choice("format", PAPER_FORMATS).pipe(
			Flag.optional,
			Flag.withDescription(
				"Paper size. Defaults to a4. Ignored when --width and --height are given.",
			),
		),
		width: Flag.string("width").pipe(
			Flag.withMetavar("size"),
			Flag.optional,
			Flag.withDescription(
				"Custom page width with a CSS unit, e.g. 210mm. Must be paired with --height.",
			),
		),
		height: Flag.string("height").pipe(
			Flag.withMetavar("size"),
			Flag.optional,
			Flag.withDescription(
				"Custom page height with a CSS unit, e.g. 297mm. Must be paired with --width.",
			),
		),
		margin: Flag.string("margin").pipe(
			Flag.withMetavar("size"),
			Flag.optional,
			Flag.withDescription(
				"Margin on all four sides, e.g. 1cm or 0.5in. Defaults to none.",
			),
		),
		landscape: Flag.boolean("landscape").pipe(
			Flag.withDescription("Use landscape orientation instead of portrait."),
		),
		scale: Flag.float("scale").pipe(
			Flag.withMetavar("0.1-2"),
			Flag.optional,
			Flag.withDescription("Scale the rendered content. Defaults to 1."),
		),
		...sharedFlags,
	},
	(config) =>
		Effect.gen(function* () {
			const render = yield* Render;

			const width = Option.getOrUndefined(config.width);
			const height = Option.getOrUndefined(config.height);
			if ((width === undefined) !== (height === undefined)) {
				return yield* Effect.fail(
					new RenderError({
						reason:
							"--width and --height must be given together, or neither. Use --format for a standard paper size.",
					}),
				);
			}

			const source = yield* resolveSource(config.composition);
			const props = yield* resolveProps(config.props);
			const output = Option.getOrElse(config.output, () => "out/document.pdf");
			const margin = Option.getOrElse(config.margin, () => "0");

			const written = yield* render.toPdf({
				source,
				props,
				assetDir: Option.getOrUndefined(config.assets),
				head: Option.getOrUndefined(config.head),
				tailwind: !config.noTailwind,
				waitUntil: Option.getOrElse(config.wait, () => "networkidle"),
				outputPath: resolve(output),
				paperFormat: Option.getOrUndefined(config.format),
				pageWidth: width,
				pageHeight: height,
				margin: { top: margin, right: margin, bottom: margin, left: margin },
				landscape: config.landscape,
				scale: Option.getOrElse(config.scale, () => 1),
			});
			if (config.json) {
				return yield* emitJson({
					output: written,
					kind: "pdf",
					format: Option.getOrElse(config.format, () => "a4"),
					landscape: config.landscape,
					margin,
				});
			}
			yield* Console.log(written);
		}),
).pipe(
	Command.withShortDescription("Render a composition to a PDF."),
	Command.withDescription(
		`Render a TSX composition to a PDF document.

Backgrounds are printed, so a composition styled for screen comes out
looking the same on paper. Only the written path goes to stdout.

Package imports inside the composition are installed on demand from
Bun's cache, so a composition can use any npm library without any
project setup. It renders in isolation and never picks up dependencies
from the surrounding directory.

Requires Google Chrome or Chromium; set CHROME_PATH to choose one.`,
	),
	Command.withExamples([
		{
			command: "infer render pdf invoice.tsx -o invoice.pdf",
			description: "Render a composition to a PDF",
		},
		{
			command: `infer render pdf invoice.tsx --props ./data.json --margin 1cm`,
			description: "Load props from a file and add margins",
		},
		{
			command: "infer render pdf slides.tsx --format letter --landscape",
			description: "Use a different paper size and orientation",
		},
		{
			command: "infer render pdf label.tsx --width 100mm --height 60mm",
			description: "Use a custom page size",
		},
	]),
);

// --- video ----------------------------------------------------------------

const videoCmd = Command.make(
	"video",
	{
		composition: Argument.string("composition").pipe(
			Argument.optional,
			Argument.withDescription(COMPOSITION_NOTE),
		),
		output: Flag.string("output").pipe(
			Flag.withAlias("o"),
			Flag.withMetavar("path"),
			Flag.optional,
			Flag.withDescription(
				"Where to write the video. Defaults to out/video.mp4.",
			),
		),
		width: Flag.integer("width").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription(
				"Frame width. Overrides the composition's own config; defaults to 1920.",
			),
		),
		height: Flag.integer("height").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription(
				"Frame height. Overrides the composition's own config; defaults to 1080.",
			),
		),
		fps: Flag.integer("fps").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Frames per second. Overrides the composition's own config; defaults to 30.",
			),
		),
		duration: Flag.integer("duration").pipe(
			Flag.withMetavar("frames"),
			Flag.optional,
			Flag.withDescription(
				"Length in frames, not seconds — at 30fps, 150 is five seconds. Overrides the composition's own config.",
			),
		),
		codec: Flag.choice("codec", CODECS).pipe(
			Flag.optional,
			Flag.withDescription(
				"Output codec. Defaults to h264. Use prores for editing, gif for a looping animation, or mp3/aac/wav to extract audio only.",
			),
		),
		from: Flag.integer("from").pipe(
			Flag.withMetavar("frame"),
			Flag.optional,
			Flag.withDescription(
				"First frame to render, for previewing part of a long composition.",
			),
		),
		to: Flag.integer("to").pipe(
			Flag.withMetavar("frame"),
			Flag.optional,
			Flag.withDescription("Last frame to render, inclusive."),
		),
		concurrency: Flag.integer("concurrency").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"How many browser tabs render frames in parallel. Defaults to a value derived from the CPU count; lower it if memory is tight.",
			),
		),
		crf: Flag.integer("crf").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Constant rate factor — lower is better quality and a bigger file. Roughly 1-51 for h264, where 18 is visually near-lossless.",
			),
		),
		scale: Flag.float("scale").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Multiply the frame dimensions, e.g. 2 to render 1920x1080 at 3840x2160.",
			),
		),
		muted: Flag.boolean("muted").pipe(
			Flag.withDescription("Drop the audio track from the output."),
		),
		frame: Flag.integer("frame").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Render just this one frame as a still image instead of encoding a video. Nothing is encoded, so it is far faster than a full render — the quick way to check a composition looks right at a given moment before committing to the whole thing. The output extension picks the format (.png or .jpeg); defaults to out/frame.png.",
			),
		),
		assets: Flag.string("assets").pipe(
			Flag.withMetavar("dir"),
			Flag.optional,
			Flag.withDescription(
				"Directory of local files the composition loads with staticFile(). Symlinked rather than copied, so a large folder costs nothing. Note this differs from image and pdf, which resolve plain relative URLs.",
			),
		),
		props: Flag.string("props").pipe(
			Flag.withMetavar("json|path"),
			Flag.optional,
			Flag.withDescription(PROPS_NOTE),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const render = yield* Render;

			const from = Option.getOrUndefined(config.from);
			const to = Option.getOrUndefined(config.to);
			if (from !== undefined && to !== undefined && from > to) {
				return yield* Effect.fail(
					new RenderError({ reason: "--from must not be greater than --to." }),
				);
			}

			// Only explicitly-set flags are forwarded, so an unset one never
			// overrides what the composition exported.
			const dimensions: Record<string, number> = {};
			if (Option.isSome(config.width)) dimensions.width = config.width.value;
			if (Option.isSome(config.height)) dimensions.height = config.height.value;
			if (Option.isSome(config.fps)) dimensions.fps = config.fps.value;
			if (Option.isSome(config.duration)) {
				dimensions.durationInFrames = config.duration.value;
			}

			const frame = Option.getOrUndefined(config.frame);
			if (frame !== undefined && frame < 0) {
				return yield* Effect.fail(
					new RenderError({ reason: "--frame must not be negative." }),
				);
			}
			if (frame !== undefined && (from !== undefined || to !== undefined)) {
				return yield* Effect.fail(
					new RenderError({
						reason:
							"--frame renders a single still, so it cannot be combined with --from or --to.",
					}),
				);
			}

			const source = yield* resolveSource(config.composition);
			const props = yield* resolveProps(config.props);
			const output = Option.getOrElse(config.output, () =>
				frame === undefined ? "out/video.mp4" : "out/frame.png",
			);

			yield* Console.error(
				"Note: Remotion requires a paid company licence for for-profit organisations with 4 or more employees. See https://remotion.pro",
			);

			const written = yield* render.toVideo({
				source,
				props,
				outputPath: resolve(output),
				assetDir: Option.getOrUndefined(config.assets),
				dimensions,
				codec: Option.getOrElse(config.codec, () => "h264"),
				concurrency: Option.getOrUndefined(config.concurrency),
				crf: Option.getOrUndefined(config.crf),
				scale: Option.getOrUndefined(config.scale),
				frameRange:
					from !== undefined && to !== undefined
						? ([from, to] as const)
						: from !== undefined
							? from
							: undefined,
				muted: config.muted,
				frame,
				stillFormat: /\.jpe?g$/i.test(output) ? "jpeg" : "png",
			});
			if (config.json) {
				return yield* emitJson({
					output: written,
					kind: frame === undefined ? "video" : "still",
					...(frame === undefined
						? { codec: Option.getOrElse(config.codec, () => "h264") }
						: { frame }),
					...dimensions,
				});
			}
			yield* Console.log(written);
		}),
).pipe(
	Command.withShortDescription("Render a composition to a video."),
	Command.withDescription(
		`Render a TSX composition to a video, using Remotion.

The component is rendered frame by frame, so it can animate with
Remotion's useCurrentFrame() and Sequence primitives. Only the written
path goes to stdout; progress goes to stderr.

Frame size and length come from the composition when it exports a
config, and any flag overrides it:

  export const config = { width: 1080, height: 1920, fps: 30, durationInFrames: 90 };

Use --frame to render one frame as a still instead. That skips encoding
entirely, so it is the fast way to check a composition looks right at a
given moment before rendering all of it.

Packages the composition imports are installed on demand from Bun's
cache. The first video render also downloads a Chrome build, which is
then reused, so expect it to be slower than later ones.

Licence: Remotion is free for individuals, non-profits and for-profit
organisations with up to 3 employees. Larger organisations need a paid
company licence — see https://remotion.pro`,
	),
	Command.withExamples([
		{
			command: "infer render video intro.tsx -o intro.mp4",
			description: "Render a composition to an MP4",
		},
		{
			command: `infer render video intro.tsx --props '{"title":"Hello"}' --duration 90`,
			description: "Pass props and set the length in frames",
		},
		{
			command: "infer render video intro.tsx --width 1080 --height 1920",
			description: "Render vertically for social",
		},
		{
			command: "infer render video intro.tsx --from 0 --to 30",
			description: "Render only the first second, to check the start",
		},
		{
			command: "infer render video intro.tsx --codec gif -o preview.gif",
			description: "Produce a looping GIF instead",
		},
		{
			command: "infer render video intro.tsx --frame 45 -o check.png",
			description: "Peek at one frame without encoding a video",
		},
	]),
);

export const renderCmd = Command.make("render").pipe(
	Command.withShortDescription(
		"Render TSX compositions to images, PDFs and videos.",
	),
	Command.withDescription(
		`Turn a React TSX component into an image or a PDF.

A composition is a .tsx file with a default export taking props. It may
import other .tsx files and any npm package; both are resolved for you,
in isolation from whatever project the file happens to live in.`,
	),
	Command.withSubcommands([imageCmd, pdfCmd, videoCmd]),
);
