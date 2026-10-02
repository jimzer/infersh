/**
 * `infer media` — common ffmpeg jobs with the defaults agents get wrong
 * already right. See `src/media.ts` and `docs/adrs/0030`.
 */

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { layer, Media, MediaError, parseTime } from "../media.ts";
import { emitJson, jsonFlag } from "../output.ts";

const inputArg = Argument.String("input").pipe(
	Argument.withDescription(
		"The media file to read: anything ffmpeg can open (mp4, mov, mkv, webm, avi, mp3, wav, m4a, ...).",
	),
);

const outputFlag = (defaults: string) =>
	Flag.String("output").pipe(
		Flag.withAlias("o"),
		Flag.withMetavar("path"),
		Flag.optional,
		Flag.withDescription(
			`Where to write the result. ${defaults} An existing file there is replaced; the input never is.`,
		),
	);

/** A time flag that takes 12, 12.5, 1:02 or 01:02:03.5. */
const timeFlag = (name: string, description: string) =>
	Flag.String(name).pipe(
		Flag.withMetavar("time"),
		Flag.optional,
		Flag.withDescription(
			`${description} Seconds (12.5) or a clock time (1:02, 01:02:03.5).`,
		),
	);

const toSeconds = (
	flag: string,
	value: Option.Option<string>,
): Effect.Effect<number | undefined, MediaError> =>
	Option.match(value, {
		onNone: () => Effect.succeed(undefined),
		onSome: (raw) => {
			const seconds = parseTime(raw);
			return seconds === null
				? Effect.fail(
						new MediaError({
							reason: `--${flag} ${raw} is not a time. Use seconds (12.5) or a clock time (1:02, 01:02:03.5).`,
						}),
					)
				: Effect.succeed(seconds);
		},
	});

const positive = (flag: string, value: number) =>
	value > 0
		? Effect.succeed(value)
		: Effect.fail(new MediaError({ reason: `--${flag} must be above 0.` }));

/** The written path on stdout, or the whole report with --json. */
const emit = (json: boolean, result: { readonly output: string }) =>
	json ? emitJson(result) : Console.log(result.output);

const infoCmd = Command.make(
	"info",
	{ input: inputArg, json: jsonFlag },
	(config) =>
		Effect.gen(function* () {
			const media = yield* Media;
			yield* emitJson(yield* media.info(config.input));
		}),
).pipe(
	Command.withShortDescription(
		"Duration, size, dimensions, fps and codecs as compact JSON.",
	),
	Command.withDescription(
		`Describe a media file as one small JSON object, instead of parsing
ffprobe's hundreds of lines:

  file, format, duration (s), size (bytes), bitrate (bit/s),
  video: codec, width, height, fps, pixelFormat, rotation, frames
  audio: codec, channels, layout, sampleRate
  streams: how many video, audio and subtitle streams

Width and height are as displayed: a phone video stored landscape with a
90° rotation reports portrait dimensions, plus "rotation". Cover art in an
MP3 or M4A is not counted as video. Fields ffprobe does not know are left
out rather than null. video or audio is absent when the file has none.

Always prints JSON; --json is accepted and changes nothing.`,
	),
	Command.withExamples([
		{
			command: "infer media info clip.mov",
			description: "What is in this file?",
		},
		{
			command: "infer media info clip.mov | jq .duration",
			description: "Just the duration in seconds",
		},
	]),
);

const webCmd = Command.make(
	"web",
	{
		input: inputArg,
		output: outputFlag(
			"Must end in .mp4. Defaults to <input>.web.mp4 beside the input.",
		),
		maxWidth: Flag.Int("max-width").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription(
				"Scale down to at most this width, keeping the aspect ratio. Never scales up. 1920 or 1280 suit most web pages and chat apps.",
			),
		),
		crf: Flag.Int("crf").pipe(
			Flag.withMetavar("0-51"),
			Flag.withDefault(23),
			Flag.withDescription(
				"Quality: lower is better and bigger. 23 is the x264 default and looks good; 18 is visually lossless; 28 for small previews. Each +6 roughly halves the size.",
			),
		),
		preset: Flag.Literals("preset", [
			"ultrafast",
			"veryfast",
			"fast",
			"medium",
			"slow",
			"veryslow",
		]).pipe(
			Flag.withDefault("medium"),
			Flag.withDescription(
				"Encoding speed against file size at the same quality. slow gives ~5-10% smaller files for ~2x the time; veryfast the reverse.",
			),
		),
		noAudio: Flag.Boolean("no-audio").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Drop the audio track, e.g. for a silent background or demo video.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const media = yield* Media;
			const maxWidth = Option.getOrUndefined(config.maxWidth);
			if (maxWidth !== undefined) yield* positive("max-width", maxWidth);
			if (config.crf < 0 || config.crf > 51) {
				return yield* Effect.fail(
					new MediaError({ reason: "--crf must be between 0 and 51." }),
				);
			}
			const result = yield* media.web({
				input: config.input,
				...(Option.isSome(config.output)
					? { output: config.output.value }
					: {}),
				...(maxWidth !== undefined ? { maxWidth } : {}),
				crf: config.crf,
				preset: config.preset,
				audio: !config.noAudio,
			});
			yield* emit(config.json, result);
		}),
).pipe(
	Command.withShortDescription("Re-encode to an MP4 that plays everywhere."),
	Command.withDescription(
		`Re-encode any video to an MP4 that plays in every browser, on iOS and
Android, in Slack, Keynote and QuickTime:

  - H.264 video in yuv420p. A 4:4:4 or 10-bit source (screen recorders,
    HDR phones, ProRes) otherwise stays that way, and Safari, iOS and
    hardware decoders refuse it.
  - Even width and height, which yuv420p H.264 requires. An odd side loses
    one row or column (cropped, not rescaled, so nothing softens).
  - +faststart: the index is moved to the front so playback starts before
    the whole file has downloaded.
  - AAC audio at 128 kb/s, downmixed to stereo when the source has more.

Only the first video and first audio stream are kept; rotation metadata is
applied. Writes <input>.web.mp4 unless -o says otherwise. Only the path
goes to stdout; --json reports output, duration, width, height and size,
read back from the written file.

For anything this does not cover, ffmpeg itself is there.`,
	),
	Command.withExamples([
		{
			command: "infer media web screen-recording.mov",
			description: "A recording that will play anywhere",
		},
		{
			command:
				"infer media web clip.mkv --max-width 1280 --crf 28 -o preview.mp4",
			description: "A small preview",
		},
		{
			command: "infer media web demo.mov --no-audio --json",
			description: "Silent, with the result as JSON",
		},
	]),
);

const gifCmd = Command.make(
	"gif",
	{
		input: inputArg,
		output: outputFlag("Defaults to <input>.gif beside the input."),
		fps: Flag.Int("fps").pipe(
			Flag.withMetavar("n"),
			Flag.withDefault(15),
			Flag.withDescription(
				"Frames per second. 15 looks smooth for UI and screen captures; 10 halves the size again; above 25 is rarely worth the bytes.",
			),
		),
		width: Flag.Int("width").pipe(
			Flag.withMetavar("px"),
			Flag.withDefault(480),
			Flag.withDescription(
				"Width in pixels; height follows the aspect ratio. Never scaled above the source. GIF size grows with the area, so 480 is a sensible ceiling for chat and READMEs.",
			),
		),
		from: timeFlag("from", "Start here instead of at the beginning."),
		to: timeFlag("to", "Stop here instead of at the end."),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const media = yield* Media;
			const from = yield* toSeconds("from", config.from);
			const to = yield* toSeconds("to", config.to);
			yield* positive("fps", config.fps);
			yield* positive("width", config.width);
			const result = yield* media.gif({
				input: config.input,
				...(Option.isSome(config.output)
					? { output: config.output.value }
					: {}),
				fps: config.fps,
				width: config.width,
				...(from !== undefined ? { from } : {}),
				...(to !== undefined ? { to } : {}),
			});
			yield* emit(config.json, result);
		}),
).pipe(
	Command.withShortDescription(
		"A GIF with its own palette, so it is not banded.",
	),
	Command.withDescription(
		`Convert a video, or part of one, to an animated GIF that loops.

GIF has 256 colours. A plain ffmpeg -i in.mp4 out.gif uses one generic
palette for every video, which bands gradients and turns flat colours
speckled. This runs two passes: the first computes the best 256 colours
for this clip, the second maps every frame onto them with dithering, and
only redraws what changed between frames, which also keeps files smaller.

GIFs are large: keep them short (a few seconds, --from/--to), narrow
(--width) and at 10-15 fps. For anything longer, a muted MP4 from
infer media web --no-audio is a fraction of the size and plays inline
almost everywhere a GIF does.

Only the path goes to stdout; --json reports output, duration, width,
height and size.`,
	),
	Command.withExamples([
		{
			command: "infer media gif demo.mp4 --from 3 --to 7",
			description: "Four seconds as a GIF",
		},
		{
			command:
				"infer media gif screen.mov --width 640 --fps 10 -o docs/flow.gif",
			description: "A wider, lighter GIF for a README",
		},
	]),
);

const trimCmd = Command.make(
	"trim",
	{
		input: inputArg,
		output: outputFlag(
			"Defaults to <input>.trim.<ext> beside the input, in the input's container.",
		),
		from: timeFlag("from", "Where the cut starts. Defaults to 0."),
		to: timeFlag("to", "Where the cut ends. Defaults to the end."),
		copy: Flag.Boolean("copy").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Copy the streams instead of re-encoding: instant and lossless, but the cut can only start on a keyframe — often a second or more before --from — so the clip starts early or opens on a frozen frame. Fine for rough cuts of long files; wrong when the first frame matters.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const media = yield* Media;
			const from = yield* toSeconds("from", config.from);
			const to = yield* toSeconds("to", config.to);
			if (from === undefined && to === undefined) {
				return yield* Effect.fail(
					new MediaError({
						reason: "Pass --from, --to or both: a trim with neither is a copy.",
					}),
				);
			}
			const result = yield* media.trim({
				input: config.input,
				...(Option.isSome(config.output)
					? { output: config.output.value }
					: {}),
				from: from ?? 0,
				...(to !== undefined ? { to } : {}),
				copy: config.copy,
			});
			yield* emit(config.json, result);
		}),
).pipe(
	Command.withShortDescription("Cut a clip on the exact frame."),
	Command.withDescription(
		`Cut a section out of a video or audio file, starting and ending on the
exact frame.

The default re-encodes, because that is the only way to start anywhere
but a keyframe. MP4 and MOV outputs get the same H.264/AAC as
infer media web, at CRF 18 (visually lossless — a cut is an edit, not
the final delivery), with even dimensions and +faststart. Other
containers (mkv, webm, mp3, wav, ...) use ffmpeg's own codecs for them.
All audio tracks are kept.

--copy cuts without re-encoding: instant and lossless, but it starts on
the keyframe before --from, so the clip begins early and its duration is
not exact. Use it for rough cuts of long recordings.

Only the path goes to stdout; --json reports output, duration, width,
height and size, read back from the written file.`,
	),
	Command.withExamples([
		{
			command: "infer media trim talk.mp4 --from 1:30 --to 2:15",
			description: "45 seconds, frame-accurate",
		},
		{
			command: "infer media trim recording.mkv --from 600 --copy -o part.mkv",
			description: "Everything after 10 minutes, instantly",
		},
	]),
);

const framesCmd = Command.make(
	"frames",
	{
		input: inputArg,
		output: outputFlag(
			"A contact sheet defaults to <input>.frames.jpg (.png also works); --stills writes a directory, defaulting to <input>.frames/.",
		),
		count: Flag.Int("count").pipe(
			Flag.withMetavar("n"),
			Flag.withDefault(12),
			Flag.withDescription(
				"How many frames, evenly spaced: the middle of each of n equal slices, so neither the first nor the last frame (often black) is picked.",
			),
		),
		columns: Flag.Int("columns").pipe(
			Flag.withMetavar("n"),
			Flag.withDefault(4),
			Flag.withDescription("Frames per row on the contact sheet."),
		),
		width: Flag.Int("width").pipe(
			Flag.withMetavar("px"),
			Flag.optional,
			Flag.withDescription(
				"Width of each frame. Defaults to 320 on a contact sheet (4 columns make a ~1300px image, readable at a glance), and to the source width for --stills.",
			),
		),
		stills: Flag.Boolean("stills").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Write each frame as its own JPEG (frame-001.jpg, ...) in a directory instead of one contact sheet. For when detail matters more than the overview.",
			),
		),
		noTimestamps: Flag.Boolean("no-timestamps").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Do not burn each frame's time into its bottom-left corner.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const media = yield* Media;
			yield* positive("count", config.count);
			yield* positive("columns", config.columns);
			const width = Option.getOrUndefined(config.width);
			if (width !== undefined) yield* positive("width", width);
			const result = yield* media.frames({
				input: config.input,
				...(Option.isSome(config.output)
					? { output: config.output.value }
					: {}),
				count: config.count,
				columns: config.columns,
				...(width !== undefined ? { width } : {}),
				stills: config.stills,
				labels: !config.noTimestamps,
			});
			if (config.json) return yield* emitJson(result);
			if (config.stills) {
				for (const frame of result.frames) {
					if (frame.path !== undefined) yield* Console.log(frame.path);
				}
				return;
			}
			yield* Console.log(result.output);
		}),
).pipe(
	Command.withShortDescription(
		"A contact sheet of evenly spaced frames, to look at a video.",
	),
	Command.withDescription(
		`Pull evenly spaced frames out of a video so you can look at it: by
default one contact sheet image, a grid of 12 frames each labelled with
its time; with --stills, separate full-size images.

Open the sheet with your image-reading tool to see what a video shows,
check a render, or find the moment to --from/--to on. Then take
--stills, or a narrower trim, for a closer look.

Each frame is a fast seek, not a decode of the whole file, so long videos
are quick. Times are in the middle of n equal slices of the duration.

stdout is the sheet's path, or one path per still. --json reports the
output, its size, the grid (columns, rows) and every frame's time in
seconds (and path, for --stills).`,
	),
	Command.withExamples([
		{
			command: "infer media frames clip.mp4",
			description: "A 4x3 contact sheet, labelled with times",
		},
		{
			command:
				"infer media frames talk.mp4 --count 24 --columns 6 -o sheet.jpg",
			description: "A denser overview",
		},
		{
			command: "infer media frames clip.mp4 --stills --count 5",
			description: "Five full-size stills in clip.frames/",
		},
	]),
);

const audioCmd = Command.make(
	"audio",
	{
		input: inputArg,
		output: outputFlag(
			"The extension picks the format: .m4a, .mp3, .wav, .flac, .opus, .ogg. Defaults to <input> with the extension of the track's own codec (.m4a for AAC), or <input>.16k.flac with --for-transcription.",
		),
		forTranscription: Flag.Boolean("for-transcription").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"16 kHz mono FLAC — what speech-to-text models resample to anyway, so nothing is lost and the file is a fraction of the size. The same conversion infer groq transcribe runs on its own.",
			),
		),
		from: timeFlag("from", "Start here instead of at the beginning."),
		to: timeFlag("to", "Stop here instead of at the end."),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const media = yield* Media;
			const from = yield* toSeconds("from", config.from);
			const to = yield* toSeconds("to", config.to);
			const result = yield* media.audio({
				input: config.input,
				...(Option.isSome(config.output)
					? { output: config.output.value }
					: {}),
				transcription: config.forTranscription,
				...(from !== undefined ? { from } : {}),
				...(to !== undefined ? { to } : {}),
			});
			yield* emit(config.json, result);
		}),
).pipe(
	Command.withShortDescription(
		"Extract the audio track, or 16 kHz mono FLAC for transcription.",
	),
	Command.withDescription(
		`Extract the first audio track of a video or audio file.

When the output's container can hold the track's codec as it is (AAC in
.m4a, MP3 in .mp3, Opus in .opus, ...) it is copied: instant and
lossless. Otherwise it is re-encoded for the extension you asked for. The
default output uses the codec's own container, so it is always a copy.

--for-transcription writes 16 kHz mono FLAC instead, ready for any
speech-to-text API. infer groq transcribe already does this conversion
itself; use this for other services, or to check the file first.

Only the path goes to stdout. --json reports output, duration, size,
codec, sampleRate, channels and whether the track was copied.`,
	),
	Command.withExamples([
		{
			command: "infer media audio interview.mp4",
			description: "The soundtrack, losslessly, as interview.m4a",
		},
		{
			command: "infer media audio meeting.mkv --for-transcription",
			description: "meeting.16k.flac for a speech-to-text API",
		},
		{
			command: "infer media audio song.mov --from 0:30 --to 1:00 -o hook.mp3",
			description: "30 seconds as MP3",
		},
	]),
);

export const mediaCmd = Command.make("media").pipe(
	Command.withShortDescription(
		"Common ffmpeg jobs with correct defaults: info, web, gif, trim, frames, audio.",
	),
	Command.withDescription(
		`Common ffmpeg jobs, with the parameters that are easy to get wrong
already right: an MP4 that plays everywhere, a GIF that is not banded, a
frame-accurate cut, a contact sheet to look at a video, an audio track
for transcription.

Needs ffmpeg and ffprobe on PATH (macOS: brew install ffmpeg;
Debian/Ubuntu: apt install ffmpeg). Outputs go beside the input unless
-o says otherwise; the input is never overwritten, and a failed run
never leaves a half-written file at the output path. stdout is the written path; --json reports
what was written, read back from the file itself.

For anything not covered here — joining clips, filters, subtitles,
streaming — call ffmpeg directly.`,
	),
	Command.withSubcommands([
		infoCmd,
		webCmd,
		gifCmd,
		trimCmd,
		framesCmd,
		audioCmd,
	]),
	Command.provide(layer),
);
