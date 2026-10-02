/**
 * `infer shot` — screenshot or print a live URL.
 */

import { resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { emitJson, jsonFlag } from "../output.ts";
import { Render, RenderError, WAIT_EVENTS } from "../render.ts";

/**
 * Adds the scheme a bare address leaves out: `http://` for this machine —
 * `localhost:3000`, `127.0.0.1:8080` — and `https://` for anything else.
 * Returns null for something that cannot be a web address.
 */
export const normalizeUrl = (raw: string): string | null => {
	const value = raw.trim();
	if (/^https?:\/\//i.test(value)) return value;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
	const local =
		/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(value);
	return `${local ? "http" : "https"}://${value}`;
};

export const shotCmd = Command.make(
	"shot",
	{
		url: Argument.String("url").pipe(
			Argument.withDescription(
				"The page to capture. A bare address works: localhost:3000 becomes http://localhost:3000, example.com becomes https://example.com.",
			),
		),
		output: Flag.String("output").pipe(
			Flag.withAlias("o"),
			Flag.withMetavar("path"),
			Flag.optional,
			Flag.withDescription(
				"Where to write the capture. The extension picks the format: .png, .jpg, .webp, or .pdf to print the page. Defaults to out/shot.png.",
			),
		),
		width: Flag.Int("width").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription(
				"Viewport width. Defaults to 1280; 390 shows the phone layout of a responsive site.",
			),
		),
		height: Flag.Int("height").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription(
				"Viewport height. Defaults to 800. With the full page captured, this only decides what counts as above the fold for --no-full-page.",
			),
		),
		noFullPage: Flag.Boolean("no-full-page").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Capture only the viewport — what is visible without scrolling — instead of the whole page.",
			),
		),
		selector: Flag.String("selector").pipe(
			Flag.withMetavar("css"),
			Flag.optional,
			Flag.withDescription(
				"Capture only the first element matching this CSS selector, e.g. #pricing or 'main > header'.",
			),
		),
		scale: Flag.Finite("scale").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Device pixel ratio. 2 captures at retina resolution, doubling the pixel dimensions. Defaults to 1.",
			),
		),
		dark: Flag.Boolean("dark").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Ask for the dark theme, as a browser set to dark mode would.",
			),
		),
		wait: Flag.Literals("wait", WAIT_EVENTS).pipe(
			Flag.optional,
			Flag.withDescription(
				"When the page counts as loaded. Defaults to load, then waits for web fonts. networkidle waits for requests to stop, but many live sites never stop (analytics, polling) and would time out.",
			),
		),
		waitFor: Flag.String("wait-for").pipe(
			Flag.withMetavar("css"),
			Flag.optional,
			Flag.withDescription(
				"Also wait until an element matching this selector exists, for pages that render their content after loading.",
			),
		),
		delay: Flag.Int("delay").pipe(
			Flag.withMetavar("ms"),
			Flag.optional,
			Flag.withDescription(
				"Extra milliseconds to wait before capturing, for animations or late-loading images.",
			),
		),
		timeout: Flag.Int("timeout").pipe(
			Flag.withMetavar("seconds"),
			Flag.optional,
			Flag.withDescription(
				"How long to wait for the page and --wait-for. Defaults to 30.",
			),
		),
		quality: Flag.Int("quality").pipe(
			Flag.withMetavar("0-100"),
			Flag.optional,
			Flag.withDescription("JPEG quality. Ignored for other formats."),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const url = normalizeUrl(config.url);
			if (url === null) {
				return yield* Effect.fail(
					new RenderError({
						reason: `Not a web address: ${config.url}. Pass an http(s) URL, or a bare one like example.com.`,
					}),
				);
			}
			const render = yield* Render;
			const output = resolve(
				Option.getOrElse(config.output, () => "out/shot.png"),
			);
			const result = yield* render.toShot({
				url,
				outputPath: output,
				width: Option.getOrElse(config.width, () => 1280),
				height: Option.getOrElse(config.height, () => 800),
				fullPage: !config.noFullPage,
				selector: Option.getOrUndefined(config.selector),
				deviceScaleFactor: Option.getOrElse(config.scale, () => 1),
				dark: config.dark,
				waitUntil: Option.getOrElse(config.wait, () => "load"),
				waitFor: Option.getOrUndefined(config.waitFor),
				delay: Option.getOrUndefined(config.delay),
				timeoutMs: Option.getOrElse(config.timeout, () => 30) * 1000,
				quality: Option.getOrUndefined(config.quality),
			});
			if (result.status !== undefined && result.status >= 400) {
				// Captured anyway — an error page is still what the URL shows —
				// but said plainly, so a 404 is not mistaken for the real page.
				yield* Console.error(
					`Note: ${result.url} answered ${result.status}; the capture shows that response.`,
				);
			}
			if (config.json) return yield* emitJson(result);
			yield* Console.log(result.output);
		}),
).pipe(
	Command.withShortDescription("Screenshot or print a live web page."),
	Command.withDescription(
		`Capture a live web page as an image or a PDF: a deployed site, a docs
page, or the app you are building on localhost.

Uses the same pinned headless Chrome as render image, so nothing is set
up and nothing new is downloaded once a render has run. The whole page is
captured by default; --no-full-page keeps only what is visible without
scrolling, and --selector a single element.

Only the written path goes to stdout. --json adds the final URL after
redirects, the page title and its HTTP status. A page that answers 4xx or
5xx is still captured, with a note.`,
	),
	Command.withExamples([
		{
			command: "infer shot localhost:3000 -o home.png",
			description: "Capture the app you are building",
		},
		{
			command: "infer shot example.com --width 390 --no-full-page",
			description: "What a phone sees before scrolling",
		},
		{
			command: "infer shot example.com --selector '#pricing' --scale 2",
			description: "One section, at retina resolution",
		},
		{
			command: "infer shot example.com -o page.pdf",
			description: "Print the page to PDF",
		},
	]),
);
