/**
 * `infer render` — turn TSX compositions into images and PDFs.
 */

import { resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
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

export const renderCmd = Command.make("render").pipe(
	Command.withShortDescription("Render TSX compositions to images and PDFs."),
	Command.withDescription(
		`Turn a React TSX component into an image or a PDF.

A composition is a .tsx file with a default export taking props. It may
import other .tsx files and any npm package; both are resolved for you,
in isolation from whatever project the file happens to live in.`,
	),
	Command.withSubcommands([imageCmd, pdfCmd]),
);
