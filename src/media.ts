/**
 * Common ffmpeg jobs, with the parameters agents usually get wrong already
 * right: a web MP4 that plays everywhere, a GIF that is not banded, a cut that
 * is frame-accurate, a contact sheet to look at a video, an audio track for
 * transcription. See `docs/adrs/0030`.
 *
 * Everything that decides an ffmpeg invocation is a pure function here, so
 * the choices are tested without running ffmpeg. The `Media` service runs
 * them, probes inputs and outputs with ffprobe, and keeps temp files and
 * half-written outputs scoped so a failure leaves nothing behind.
 */

import { basename, dirname, extname, join, resolve } from "node:path";
import {
	Console,
	Context,
	Data,
	Effect,
	FileSystem,
	Layer,
	Option,
	type PlatformError,
	Schema,
	type Scope,
} from "effect";
import { ffmpegArgs as transcriptionFfmpegArgs } from "./groq.ts";
import { lenient } from "./json.ts";
import { type Platform, run, type StageError, tempDir } from "./stage.ts";

export class MediaError extends Data.TaggedError("MediaError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

/**
 * The slice of `ffprobe -print_format json -show_format -show_streams` the
 * CLI reads. ffprobe prints most numbers as strings, and `N/A` where it does
 * not know one, so every field is lenient: an unknown value drops that field,
 * never the whole probe.
 */
const ProbeStream = Schema.Struct({
	index: Schema.Finite,
	codec_type: lenient(Schema.String),
	codec_name: lenient(Schema.String),
	width: lenient(Schema.Finite),
	height: lenient(Schema.Finite),
	pix_fmt: lenient(Schema.String),
	avg_frame_rate: lenient(Schema.String),
	r_frame_rate: lenient(Schema.String),
	sample_rate: lenient(Schema.FiniteFromString),
	channels: lenient(Schema.Finite),
	channel_layout: lenient(Schema.String),
	duration: lenient(Schema.FiniteFromString),
	bit_rate: lenient(Schema.FiniteFromString),
	nb_frames: lenient(Schema.FiniteFromString),
	// Phone videos are stored landscape with a rotation to apply on display.
	side_data_list: lenient(
		Schema.Array(Schema.Struct({ rotation: lenient(Schema.Finite) })),
	),
	tags: lenient(Schema.Struct({ rotate: lenient(Schema.FiniteFromString) })),
	// Cover art in an MP3 or M4A is a "video" stream flagged attached_pic.
	disposition: lenient(Schema.Struct({ attached_pic: lenient(Schema.Finite) })),
});
type ProbeStream = typeof ProbeStream.Type;

const ProbeFormat = Schema.Struct({
	format_name: lenient(Schema.String),
	duration: lenient(Schema.FiniteFromString),
	size: lenient(Schema.FiniteFromString),
	bit_rate: lenient(Schema.FiniteFromString),
});

const Probe = Schema.fromJsonString(
	Schema.Struct({
		streams: Schema.Array(ProbeStream),
		format: ProbeFormat,
	}),
);

export interface VideoInfo {
	readonly codec: string;
	/** As displayed: already swapped for a 90° rotation. */
	readonly width: number;
	readonly height: number;
	readonly fps?: number;
	readonly pixelFormat?: string;
	/** Degrees the player rotates the stored frames by, when not zero. */
	readonly rotation?: number;
	readonly frames?: number;
}

export interface AudioInfo {
	readonly codec: string;
	readonly channels?: number;
	readonly layout?: string;
	readonly sampleRate?: number;
}

export interface MediaInfo {
	readonly file: string;
	readonly format?: string;
	/** Seconds. */
	readonly duration?: number;
	/** Bytes. */
	readonly size?: number;
	/** Bits per second, over the whole file. */
	readonly bitrate?: number;
	/** The first real video stream; cover art does not count. */
	readonly video?: VideoInfo;
	/** The first audio stream. */
	readonly audio?: AudioInfo;
	/** How many streams of each kind, for files with several audio tracks. */
	readonly streams: {
		readonly video: number;
		readonly audio: number;
		readonly subtitle: number;
	};
}

/** `30000/1001` → 29.97. `0/0`, which ffprobe prints for "unknown", → none. */
export const parseRate = (rate: string | undefined): number | undefined => {
	const match = rate?.match(/^(\d+)\/(\d+)$/);
	if (!match) return undefined;
	const num = Number(match[1]);
	const den = Number(match[2]);
	if (num === 0 || den === 0) return undefined;
	return Math.round((num / den) * 1000) / 1000;
};

const rotationOf = (stream: ProbeStream): number => {
	const side = stream.side_data_list?.find(
		(entry) => entry.rotation !== undefined,
	)?.rotation;
	const raw = side ?? stream.tags?.rotate ?? 0;
	// ffprobe reports -90 for what players show as a 90° turn; either way only
	// the multiple of 180 matters for which side is longer.
	return ((Math.round(raw) % 360) + 360) % 360;
};

const isPicture = (stream: ProbeStream): boolean =>
	stream.disposition?.attached_pic === 1;

/** Turns ffprobe's JSON into the compact summary `media info` prints. */
export const summarizeProbe = (
	file: string,
	probe: typeof Probe.Type,
): MediaInfo => {
	const { streams, format } = probe;
	const videos = streams.filter(
		(s) => s.codec_type === "video" && !isPicture(s),
	);
	const audios = streams.filter((s) => s.codec_type === "audio");
	const v = videos[0];
	const a = audios[0];

	let video: VideoInfo | undefined;
	if (v?.width !== undefined && v.height !== undefined) {
		const rotation = rotationOf(v);
		const sideways = rotation % 180 === 90;
		const fps = parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate);
		video = {
			codec: v.codec_name ?? "unknown",
			width: sideways ? v.height : v.width,
			height: sideways ? v.width : v.height,
			...(fps !== undefined ? { fps } : {}),
			...(v.pix_fmt !== undefined ? { pixelFormat: v.pix_fmt } : {}),
			...(rotation !== 0 ? { rotation } : {}),
			...(v.nb_frames !== undefined ? { frames: v.nb_frames } : {}),
		};
	}

	const audio: AudioInfo | undefined =
		a === undefined
			? undefined
			: {
					codec: a.codec_name ?? "unknown",
					...(a.channels !== undefined ? { channels: a.channels } : {}),
					...(a.channel_layout !== undefined
						? { layout: a.channel_layout }
						: {}),
					...(a.sample_rate !== undefined ? { sampleRate: a.sample_rate } : {}),
				};

	// Some containers (raw streams, a few MKVs) only know durations per stream.
	const duration = format.duration ?? v?.duration ?? a?.duration;

	return {
		file,
		...(format.format_name !== undefined ? { format: format.format_name } : {}),
		...(duration !== undefined ? { duration } : {}),
		...(format.size !== undefined ? { size: format.size } : {}),
		...(format.bit_rate !== undefined ? { bitrate: format.bit_rate } : {}),
		...(video !== undefined ? { video } : {}),
		...(audio !== undefined ? { audio } : {}),
		streams: {
			video: videos.length,
			audio: audios.length,
			subtitle: streams.filter((s) => s.codec_type === "subtitle").length,
		},
	};
};

/** Decodes ffprobe's JSON text, or null when it is not what ffprobe prints. */
export const parseProbe = (file: string, text: string): MediaInfo | null =>
	Option.match(Schema.decodeUnknownOption(Probe)(text), {
		onNone: () => null,
		onSome: (probe) => summarizeProbe(file, probe),
	});

// ---------------------------------------------------------------------------
// Times, sizes and paths
// ---------------------------------------------------------------------------

/**
 * Seconds from what a person or agent writes: `12`, `12.5`, `12.5s`, `1:02`,
 * `01:02:03.25`. Null when it is none of those.
 */
export const parseTime = (raw: string): number | null => {
	const value = raw.trim().replace(/s$/i, "");
	if (!/^\d+(\.\d+)?$|^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(value)) return null;
	const parts = value.split(":").map(Number);
	return parts.reduce((total, part) => total * 60 + part, 0);
};

/** `75.25` → `1:15.2`; an hour or more → `1:02:03.0`. For frame labels. */
export const formatClock = (seconds: number): string => {
	const tenths = Math.floor(seconds * 10 + 1e-6);
	const s = (tenths % 600) / 10;
	const totalMinutes = Math.floor(tenths / 600);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	const ss = s.toFixed(1).padStart(4, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** The largest even number not above `n` — H.264 in yuv420p needs even sides. */
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The video filter that makes a frame H.264-safe: scaled down to `maxWidth`
 * (never up), then both sides made even.
 *
 * When no scaling is needed, an odd side loses its last row or column with
 * `crop` rather than being rescaled by one pixel, which would resample — and
 * soften — the whole frame. Dimensions are the displayed ones; ffmpeg applies
 * a rotation before any filter.
 */
export const evenSizeFilter = (
	width: number,
	height: number,
	maxWidth?: number,
): {
	readonly filter?: string;
	readonly width: number;
	readonly height: number;
} => {
	if (maxWidth !== undefined && width > maxWidth) {
		const w = even(maxWidth);
		const h = even((height * w) / width);
		return { filter: `scale=${w}:${h}:flags=lanczos`, width: w, height: h };
	}
	const w = even(width);
	const h = even(height);
	if (w === width && h === height) return { width, height };
	return { filter: `crop=${w}:${h}:0:0`, width: w, height: h };
};

/**
 * Where an output goes when `-o` is not given: beside the input, named after
 * it. `clip.mov` → `clip.web.mp4`. With no tag, `clip.mov` → `clip.gif`,
 * falling back to `clip.out.gif` rather than ever overwriting the input.
 */
export const defaultOutput = (
	input: string,
	tag: string | null,
	ext: string,
): string => {
	const abs = resolve(input);
	const stem = join(dirname(abs), basename(abs, extname(abs)));
	if (tag !== null) return `${stem}.${tag}${ext}`;
	const plain = `${stem}${ext}`;
	return plain === abs ? `${stem}.out${ext}` : plain;
};

// ---------------------------------------------------------------------------
// ffmpeg argument lists
// ---------------------------------------------------------------------------

/**
 * Before every job: no banner, never read stdin (an ffmpeg child reading the
 * terminal swallows keystrokes and can stall), and only errors on stderr so
 * its last lines are the reason a run failed.
 */
export const QUIET = ["-hide_banner", "-nostdin", "-v", "error", "-y"] as const;

/**
 * Input seeking: `-ss` before `-i` jumps near the point cheaply, and when the
 * output is re-encoded ffmpeg then decodes forward to the exact frame. `-t` is
 * a duration measured from that point.
 */
export const seekArgs = (
	input: string,
	from?: number,
	to?: number,
): ReadonlyArray<string> => [
	...(from !== undefined && from > 0 ? ["-ss", String(from)] : []),
	...(to !== undefined ? ["-t", String(to - (from ?? 0))] : []),
	"-i",
	input,
];

export interface H264Options {
	readonly crf: number;
	readonly preset: string;
	readonly filter?: string;
	readonly audio: boolean;
	/** Source channel count; more than two is downmixed to stereo. */
	readonly channels?: number;
	readonly audioBitrate: string;
}

/**
 * H.264 + AAC in MP4 that plays everywhere — browsers, iOS, Slack, Keynote:
 *
 * - `libx264` with `yuv420p`. A 4:4:4 or 10-bit source otherwise stays 4:4:4
 *   or 10-bit, which Safari, iOS and most hardware decoders refuse.
 * - `-movflags +faststart` moves the index (`moov`) before the media data, so
 *   playback starts before the whole file has downloaded.
 * - AAC, stereo at most: 5.1 AAC is not decoded everywhere.
 */
export const h264Args = (options: H264Options): ReadonlyArray<string> => [
	"-c:v",
	"libx264",
	"-preset",
	options.preset,
	"-crf",
	String(options.crf),
	"-pix_fmt",
	"yuv420p",
	...(options.filter !== undefined ? ["-vf", options.filter] : []),
	...(options.audio
		? [
				"-c:a",
				"aac",
				"-b:a",
				options.audioBitrate,
				...(options.channels !== undefined && options.channels > 2
					? ["-ac", "2"]
					: []),
			]
		: ["-an"]),
	"-movflags",
	"+faststart",
];

export interface WebOptions {
	readonly input: string;
	readonly output: string;
	readonly width: number;
	readonly height: number;
	readonly maxWidth?: number;
	readonly crf: number;
	readonly preset: string;
	readonly audio: boolean;
	readonly channels?: number;
}

/** `media web`: first video and first audio stream, H.264-safe. */
export const webArgs = (options: WebOptions): ReadonlyArray<string> => {
	const { filter } = evenSizeFilter(
		options.width,
		options.height,
		options.maxWidth,
	);
	return [
		...QUIET,
		"-i",
		options.input,
		"-map",
		"0:v:0",
		...(options.audio ? ["-map", "0:a:0?"] : []),
		...h264Args({
			crf: options.crf,
			preset: options.preset,
			...(filter !== undefined ? { filter } : {}),
			audio: options.audio,
			...(options.channels !== undefined ? { channels: options.channels } : {}),
			audioBitrate: "128k",
		}),
		options.output,
	];
};

export interface GifOptions {
	readonly input: string;
	readonly output: string;
	readonly palette: string;
	readonly fps: number;
	readonly width: number;
	readonly from?: number;
	readonly to?: number;
}

/**
 * The shared front of both GIF passes: the same frames, at the same rate and
 * size, so the palette is computed from exactly what will be drawn. Lanczos
 * keeps edges sharp when scaling down.
 */
const gifFrames = (options: GifOptions): string =>
	`fps=${options.fps},scale=${options.width}:-1:flags=lanczos`;

/**
 * Pass one: one 256-colour palette for the whole clip, from its own colours.
 * Without it ffmpeg uses a generic palette and gradients come out banded.
 * `stats_mode=diff` weighs what moves, which is what the eye follows.
 */
export const gifPaletteArgs = (options: GifOptions): ReadonlyArray<string> => [
	...QUIET,
	...seekArgs(options.input, options.from, options.to),
	"-vf",
	`${gifFrames(options)},palettegen=stats_mode=diff`,
	"-frames:v",
	"1",
	"-update",
	"1",
	options.palette,
];

/**
 * Pass two: map every frame onto that palette with error-diffusion dithering,
 * redrawing only the rectangle that changed (smaller files). Loops forever.
 */
export const gifEncodeArgs = (options: GifOptions): ReadonlyArray<string> => [
	...QUIET,
	...seekArgs(options.input, options.from, options.to),
	"-i",
	options.palette,
	"-lavfi",
	`${gifFrames(options)}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
	"-loop",
	"0",
	options.output,
];

/** Containers `trim` re-encodes as H.264/AAC; anything else keeps ffmpeg's defaults. */
const MP4_LIKE = new Set([".mp4", ".m4v", ".mov"]);

export interface TrimOptions {
	readonly input: string;
	readonly output: string;
	readonly from: number;
	readonly to: number;
	/** Stream copy: instant and lossless, but starts on a keyframe. */
	readonly copy: boolean;
	/** Displayed size of the video, when there is one. */
	readonly width?: number;
	readonly height?: number;
	readonly channels?: number;
}

/**
 * `media trim`. Re-encoding is the default because it is the only way to cut
 * on an exact frame: a stream copy can only start on a keyframe, often seconds
 * before `--from`, and players show the lead-in or a frozen frame.
 *
 * MP4 and MOV outputs get the web encode at CRF 18 — visually lossless,
 * because a cut is an edit, not a delivery. Every video, audio and
 * subtitle stream is kept — except subtitles in MP4/MOV, which
 * cannot carry most subtitle formats.
 */
export const trimArgs = (options: TrimOptions): ReadonlyArray<string> => {
	const maps = ["-map", "0:v?", "-map", "0:a?", "-map", "0:s?"];
	if (options.copy) {
		return [
			...QUIET,
			...seekArgs(options.input, options.from, options.to),
			...maps,
			"-c",
			"copy",
			// Copied packets keep timestamps from before the cut point.
			"-avoid_negative_ts",
			"make_zero",
			options.output,
		];
	}
	const mp4 = MP4_LIKE.has(extname(options.output).toLowerCase());
	const video =
		options.width !== undefined && options.height !== undefined
			? evenSizeFilter(options.width, options.height)
			: undefined;
	return [
		...QUIET,
		...seekArgs(options.input, options.from, options.to),
		"-map",
		"0:v:0?",
		"-map",
		"0:a?",
		...(mp4
			? [
					...h264Args({
						crf: 18,
						preset: "medium",
						...(video?.filter !== undefined ? { filter: video.filter } : {}),
						audio: true,
						...(options.channels !== undefined
							? { channels: options.channels }
							: {}),
						audioBitrate: "192k",
					}),
				]
			: ["-map", "0:s?"]),
		options.output,
	];
};

export interface StillOptions {
	readonly input: string;
	readonly output: string;
	readonly time: number;
	readonly width: number;
	/** Burn this text into the bottom-left corner. */
	readonly label?: string;
}

/** Escapes text for drawtext's `text='…'`: quotes, colons, backslashes. */
export const escapeDrawtext = (text: string): string =>
	text.replace(/[\\':%]/g, (c) => `\\${c}`);

/**
 * One frame at an exact time, scaled to `width` (height follows, even).
 * Input seeking makes this fast on long files: ffmpeg jumps to the nearest
 * keyframe and decodes forward only from there.
 */
export const stillArgs = (options: StillOptions): ReadonlyArray<string> => {
	const fontSize = Math.max(12, Math.round(options.width / 18));
	const filters = [`scale=${options.width}:-2:flags=lanczos`];
	if (options.label !== undefined) {
		filters.push(
			`drawtext=text='${escapeDrawtext(options.label)}':x=${Math.round(fontSize / 2)}:y=h-th-${Math.round(fontSize / 2)}:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${Math.round(fontSize / 4)}`,
		);
	}
	return [
		...QUIET,
		"-ss",
		String(options.time),
		"-i",
		options.input,
		"-frames:v",
		"1",
		"-vf",
		filters.join(","),
		"-q:v",
		"2",
		"-update",
		"1",
		options.output,
	];
};

/** Evenly spaced sample times: the middle of each of `count` equal slices. */
export const sampleTimes = (
	duration: number,
	count: number,
): ReadonlyArray<number> =>
	Array.from(
		{ length: count },
		(_, i) => Math.round(((duration * (i + 0.5)) / count) * 1000) / 1000,
	);

/** A grid of `columns` across, as many rows as `count` needs. */
export const gridFor = (
	count: number,
	columns: number,
): { readonly columns: number; readonly rows: number } => {
	const cols = Math.max(1, Math.min(columns, count));
	return { columns: cols, rows: Math.ceil(count / cols) };
};

/** Tiles numbered stills (`001.png`…) into one image; a short last row is padded. */
export const sheetArgs = (options: {
	readonly pattern: string;
	readonly output: string;
	readonly columns: number;
	readonly rows: number;
}): ReadonlyArray<string> => [
	...QUIET,
	"-framerate",
	"1",
	"-i",
	options.pattern,
	"-vf",
	`tile=${options.columns}x${options.rows}:padding=4:margin=4:color=0x161616`,
	"-frames:v",
	"1",
	"-q:v",
	"2",
	"-update",
	"1",
	options.output,
];

/** The container that holds a codec as-is, for a lossless `audio` extraction. */
export const COPY_EXTENSIONS: Readonly<Record<string, ReadonlyArray<string>>> =
	{
		aac: [".m4a", ".aac", ".mp4"],
		alac: [".m4a"],
		mp3: [".mp3"],
		opus: [".opus", ".ogg", ".webm", ".mka"],
		vorbis: [".ogg", ".mka"],
		flac: [".flac", ".mka"],
		ac3: [".ac3", ".mka"],
		eac3: [".eac3", ".mka"],
		pcm_s16le: [".wav"],
		pcm_s24le: [".wav"],
		pcm_f32le: [".wav"],
	};

/** Re-encode settings by extension, for when the source codec cannot be copied. */
const ENCODE_FOR: Readonly<Record<string, ReadonlyArray<string>>> = {
	".m4a": ["-c:a", "aac", "-b:a", "192k"],
	".aac": ["-c:a", "aac", "-b:a", "192k"],
	".mp3": ["-c:a", "libmp3lame", "-q:a", "2"],
	".flac": ["-c:a", "flac"],
	".wav": ["-c:a", "pcm_s16le"],
	".opus": ["-c:a", "libopus", "-b:a", "128k"],
	".ogg": ["-c:a", "libopus", "-b:a", "128k"],
};

/** Whether `codec` fits `ext` without re-encoding. */
export const canCopyAudio = (codec: string | undefined, ext: string): boolean =>
	codec !== undefined &&
	(COPY_EXTENSIONS[codec]?.includes(ext.toLowerCase()) ?? false);

/** The extension `audio` picks with no `-o`: the codec's own, else `.m4a`. */
export const audioExtension = (codec: string | undefined): string =>
	(codec !== undefined ? COPY_EXTENSIONS[codec]?.[0] : undefined) ?? ".m4a";

/**
 * `media audio`: the first audio track. Copied when the output's container
 * can hold the codec as-is — instant and lossless — otherwise re-encoded.
 */
export const audioArgs = (options: {
	readonly input: string;
	readonly output: string;
	readonly codec?: string;
	readonly from?: number;
	readonly to?: number;
}): ReadonlyArray<string> => {
	const ext = extname(options.output).toLowerCase();
	const codec = canCopyAudio(options.codec, ext)
		? ["-c:a", "copy"]
		: (ENCODE_FOR[ext] ?? []);
	return [
		...QUIET,
		...seekArgs(options.input, options.from, options.to),
		"-map",
		"0:a:0",
		"-vn",
		...codec,
		options.output,
	];
};

/**
 * `media audio --for-transcription`: exactly the 16 kHz mono FLAC pass `groq
 * transcribe` runs (ADR 9), reused from there so the two cannot drift.
 */
export const transcriptionArgs = (
	input: string,
	output: string,
): ReadonlyArray<string> => [
	...QUIET.filter((arg) => arg !== "-y"),
	...transcriptionFfmpegArgs(input, output).slice(1),
];

/** The last lines of a failed run's stderr: the reason, without the noise. */
export const tail = (stderr: string, lines = 5): string =>
	stderr.trim().split("\n").slice(-lines).join("\n");

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** What every job reports about the file it wrote, read back with ffprobe. */
export interface OutputReport {
	readonly output: string;
	readonly duration?: number;
	readonly width?: number;
	readonly height?: number;
	readonly size?: number;
}

export interface WebRequest {
	readonly input: string;
	readonly output?: string;
	readonly maxWidth?: number;
	readonly crf: number;
	readonly preset: string;
	readonly audio: boolean;
}

export interface GifRequest {
	readonly input: string;
	readonly output?: string;
	readonly fps: number;
	readonly width: number;
	readonly from?: number;
	readonly to?: number;
}

export interface TrimRequest {
	readonly input: string;
	readonly output?: string;
	readonly from: number;
	readonly to?: number;
	readonly copy: boolean;
}

export interface FramesRequest {
	readonly input: string;
	readonly output?: string;
	readonly count: number;
	readonly columns: number;
	/** Tile width for a sheet; still width (default: the source's) for stills. */
	readonly width?: number;
	readonly stills: boolean;
	readonly labels: boolean;
}

export interface FramesReport extends OutputReport {
	readonly columns?: number;
	readonly rows?: number;
	/** One entry per frame, in order: its time and, for stills, its file. */
	readonly frames: ReadonlyArray<{
		readonly time: number;
		readonly path?: string;
	}>;
}

export interface AudioRequest {
	readonly input: string;
	readonly output?: string;
	readonly transcription: boolean;
	readonly from?: number;
	readonly to?: number;
}

export interface AudioReport extends OutputReport {
	readonly codec?: string;
	readonly sampleRate?: number;
	readonly channels?: number;
	/** True when the track was copied as-is rather than re-encoded. */
	readonly copied: boolean;
}

export interface MediaShape {
	readonly info: (input: string) => Effect.Effect<MediaInfo, MediaError>;
	readonly web: (
		request: WebRequest,
	) => Effect.Effect<OutputReport, MediaError>;
	readonly gif: (
		request: GifRequest,
	) => Effect.Effect<OutputReport, MediaError>;
	readonly trim: (
		request: TrimRequest,
	) => Effect.Effect<OutputReport, MediaError>;
	readonly frames: (
		request: FramesRequest,
	) => Effect.Effect<FramesReport, MediaError>;
	readonly audio: (
		request: AudioRequest,
	) => Effect.Effect<AudioReport, MediaError>;
}

export class Media extends Context.Service<Media, MediaShape>()("Media") {}

type Failure = MediaError | StageError | PlatformError.PlatformError;

const asMediaError = (error: Failure): MediaError =>
	error instanceof MediaError
		? error
		: new MediaError({ reason: error.message });

const INSTALL_HINT =
	"infer media needs ffmpeg and ffprobe, which ship together. Install them — macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg; Windows: winget install ffmpeg — and make sure it is on PATH.";

/**
 * Runs ffmpeg or ffprobe. A tool that cannot be started is almost always one
 * that is not installed, and is said so; a failed run surfaces the last lines
 * of its stderr, which with `-v error` are the reason.
 */
const tool = (
	command: "ffmpeg" | "ffprobe",
	args: ReadonlyArray<string>,
	what: string,
) =>
	run(command, args, {
		stdout: command === "ffprobe" ? "pipe" : "ignore",
	}).pipe(
		Effect.catchTag("StageError", (error) =>
			Effect.fail(
				new MediaError({
					reason: error.reason.includes("NotFound")
						? `${command} was not found on PATH. ${INSTALL_HINT}`
						: `${command} could not be started: ${error.reason}`,
				}),
			),
		),
		Effect.flatMap((result) =>
			result.code === 0
				? Effect.succeed(result)
				: Effect.fail(
						new MediaError({
							reason: `${command} failed to ${what}:\n${tail(result.stderr) || `exit code ${result.code}`}`,
						}),
					),
		),
	);

const ffmpeg = (args: ReadonlyArray<string>, what: string) =>
	tool("ffmpeg", args, what);

/** Probes a file that must exist. */
const probe = (path: string): Effect.Effect<MediaInfo, MediaError, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const exists = yield* fs
			.exists(path)
			.pipe(Effect.orElseSucceed(() => false));
		if (!exists) {
			return yield* Effect.fail(
				new MediaError({ reason: `No such file: ${path}` }),
			);
		}
		const result = yield* tool(
			"ffprobe",
			[
				"-v",
				"error",
				"-print_format",
				"json",
				"-show_format",
				"-show_streams",
				path,
			],
			`read ${path} — it is not a media file ffmpeg understands, or it is damaged`,
		);
		const info = parseProbe(path, result.stdout);
		if (info === null) {
			return yield* Effect.fail(
				new MediaError({
					reason: `ffprobe gave an unexpected answer for ${path}.`,
				}),
			);
		}
		return info;
	});

const requireVideo = (info: MediaInfo): Effect.Effect<VideoInfo, MediaError> =>
	info.video !== undefined
		? Effect.succeed(info.video)
		: Effect.fail(
				new MediaError({
					reason: `${info.file} has no video stream.${info.audio !== undefined ? " For its audio, use infer media audio." : ""}`,
				}),
			);

const requireDuration = (info: MediaInfo): Effect.Effect<number, MediaError> =>
	info.duration !== undefined && info.duration > 0
		? Effect.succeed(info.duration)
		: Effect.fail(
				new MediaError({
					reason: `${info.file} has no known duration — a still image, or a stream ffprobe cannot time.`,
				}),
			);

/** Checks a `--from`/`--to` window against the input's duration. */
const checkWindow = (
	info: MediaInfo,
	from: number | undefined,
	to: number | undefined,
): Effect.Effect<void, MediaError> => {
	if (from !== undefined && to !== undefined && to <= from) {
		return Effect.fail(
			new MediaError({
				reason: `--to (${to}s) must be after --from (${from}s).`,
			}),
		);
	}
	if (
		from !== undefined &&
		info.duration !== undefined &&
		from >= info.duration
	) {
		return Effect.fail(
			new MediaError({
				reason: `--from ${from}s is past the end of ${info.file}, which is ${info.duration}s long.`,
			}),
		);
	}
	return Effect.void;
};

/**
 * Lets `write` produce `output` under a hidden name beside it, renamed into
 * place only on success. A failed or interrupted encode removes its partial
 * file instead of leaving a truncated video where the real one should be.
 * Beside the output rather than in the temp directory, so the rename never
 * crosses filesystems.
 */
const atomically = <A, E, R>(
	output: string,
	input: string,
	write: (partial: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MediaError, R | Platform | Scope.Scope> =>
	Effect.gen(function* () {
		if (resolve(output) === resolve(input)) {
			return yield* Effect.fail(
				new MediaError({
					reason: `The output would overwrite the input (${output}). Pass a different -o.`,
				}),
			);
		}
		const fs = yield* FileSystem.FileSystem;
		const dir = dirname(output);
		const ext = extname(output);
		yield* fs.makeDirectory(dir, { recursive: true }).pipe(
			Effect.mapError(
				(cause) =>
					new MediaError({
						reason: `Could not create ${dir}: ${cause.message}`,
					}),
			),
		);
		const partial = yield* Effect.acquireRelease(
			Effect.succeed(
				join(dir, `.${basename(output, ext)}.partial-${process.pid}${ext}`),
			),
			(path) => fs.remove(path, { force: true }).pipe(Effect.ignore),
		);
		// ffmpeg's errors name the file it was given; name the one asked for.
		const result = yield* write(partial).pipe(
			Effect.mapError((error) =>
				error instanceof MediaError
					? new MediaError({ reason: error.reason.replaceAll(partial, output) })
					: error,
			),
		);
		yield* fs.rename(partial, output).pipe(
			Effect.mapError(
				(cause) =>
					new MediaError({
						reason: `Could not write ${output}: ${cause.message}`,
					}),
			),
		);
		return result;
	});

/** Probes what was written, for the report. */
const report = (output: string) =>
	probe(output).pipe(
		Effect.map(
			(info): OutputReport => ({
				output,
				...(info.duration !== undefined ? { duration: info.duration } : {}),
				...(info.video !== undefined
					? { width: info.video.width, height: info.video.height }
					: {}),
				...(info.size !== undefined ? { size: info.size } : {}),
			}),
		),
	);

/** Whether this ffmpeg can burn text in: drawtext needs libfreetype. */
const hasDrawtext = run("ffmpeg", ["-hide_banner", "-filters"], {
	stderr: "ignore",
}).pipe(
	Effect.map((result) => /\bdrawtext\b/.test(result.stdout)),
	Effect.orElseSucceed(() => false),
);

const make = (platform: Context.Context<Platform>): MediaShape => {
	const finish = <A>(
		effect: Effect.Effect<A, Failure, Platform | Scope.Scope>,
	): Effect.Effect<A, MediaError> =>
		effect.pipe(
			Effect.scoped,
			Effect.mapError(asMediaError),
			Effect.provideContext(platform),
		);

	return {
		info: Effect.fn("Media.info")(function* (input: string) {
			return yield* probe(resolve(input));
		}, finish),

		web: Effect.fn("Media.web")(function* (request: WebRequest) {
			const input = resolve(request.input);
			const info = yield* probe(input);
			const video = yield* requireVideo(info);
			const output = resolve(
				request.output ?? defaultOutput(input, "web", ".mp4"),
			);
			if (!/\.(mp4|m4v)$/i.test(output)) {
				return yield* Effect.fail(
					new MediaError({
						reason: `web writes MP4: give -o a .mp4 path, not ${basename(output)}.`,
					}),
				);
			}
			yield* Console.error(`Encoding ${basename(output)}...`);
			yield* atomically(output, input, (partial) =>
				ffmpeg(
					webArgs({
						input,
						output: partial,
						width: video.width,
						height: video.height,
						...(request.maxWidth !== undefined
							? { maxWidth: request.maxWidth }
							: {}),
						crf: request.crf,
						preset: request.preset,
						audio: request.audio && info.audio !== undefined,
						...(info.audio?.channels !== undefined
							? { channels: info.audio.channels }
							: {}),
					}),
					`encode ${basename(input)}`,
				),
			);
			return yield* report(output);
		}, finish),

		gif: Effect.fn("Media.gif")(function* (request: GifRequest) {
			const input = resolve(request.input);
			const info = yield* probe(input);
			const video = yield* requireVideo(info);
			yield* checkWindow(info, request.from, request.to);
			const output = resolve(
				request.output ?? defaultOutput(input, null, ".gif"),
			);
			const dir = yield* tempDir("infer-media-");
			const base = {
				input,
				palette: join(dir, "palette.png"),
				fps: request.fps,
				// Never upscale: a GIF wider than its source only costs bytes.
				width: Math.min(request.width, video.width),
				...(request.from !== undefined ? { from: request.from } : {}),
				...(request.to !== undefined ? { to: request.to } : {}),
			};
			yield* Console.error(`Encoding ${basename(output)}...`);
			yield* ffmpeg(
				gifPaletteArgs({ ...base, output }),
				"build the GIF palette",
			);
			yield* atomically(output, input, (partial) =>
				ffmpeg(gifEncodeArgs({ ...base, output: partial }), "encode the GIF"),
			);
			return yield* report(output);
		}, finish),

		trim: Effect.fn("Media.trim")(function* (request: TrimRequest) {
			const input = resolve(request.input);
			const info = yield* probe(input);
			yield* checkWindow(info, request.from, request.to);
			const to =
				request.to ??
				(yield* requireDuration(info).pipe(
					Effect.mapError(
						() =>
							new MediaError({
								reason: `${input} has no known duration; pass --to.`,
							}),
					),
				));
			const output = resolve(
				request.output ?? defaultOutput(input, "trim", extname(input)),
			);
			yield* Console.error(
				`Cutting ${formatClock(request.from)}–${formatClock(to)}${request.copy ? " (stream copy)" : ""}...`,
			);
			yield* atomically(output, input, (partial) =>
				ffmpeg(
					trimArgs({
						input,
						output: partial,
						from: request.from,
						to,
						copy: request.copy,
						...(info.video !== undefined
							? { width: info.video.width, height: info.video.height }
							: {}),
						...(info.audio?.channels !== undefined
							? { channels: info.audio.channels }
							: {}),
					}),
					`cut ${basename(input)}`,
				),
			);
			return yield* report(output);
		}, finish),

		frames: Effect.fn("Media.frames")(function* (request: FramesRequest) {
			const fs = yield* FileSystem.FileSystem;
			const input = resolve(request.input);
			const info = yield* probe(input);
			const video = yield* requireVideo(info);
			const duration = yield* requireDuration(info);
			const times = sampleTimes(duration, request.count);
			const width = even(
				Math.min(
					request.width ?? (request.stills ? video.width : 320),
					video.width,
				),
			);
			const labels = request.labels && (yield* hasDrawtext);
			if (request.labels && !labels) {
				yield* Console.error(
					"This ffmpeg has no drawtext filter (built without libfreetype); frames are not labelled with their times.",
				);
			}

			const dir = yield* tempDir("infer-media-");
			const ext = request.stills ? ".jpg" : ".png";
			yield* Console.error(`Extracting ${times.length} frames...`);
			// Each still is its own short ffmpeg run that seeks straight to its
			// time, so a long video is never decoded end to end.
			const stills = yield* Effect.forEach(
				times,
				(time, i) => {
					const path = join(dir, `${String(i + 1).padStart(3, "0")}${ext}`);
					return ffmpeg(
						stillArgs({
							input,
							output: path,
							time,
							width,
							...(labels ? { label: formatClock(time) } : {}),
						}),
						`extract the frame at ${formatClock(time)}`,
					).pipe(
						Effect.andThen(fs.exists(path)),
						Effect.flatMap((written) =>
							written
								? Effect.succeed(path)
								: Effect.fail(
										new MediaError({
											reason: `ffmpeg found no frame at ${formatClock(time)} in ${input}.`,
										}),
									),
						),
					);
				},
				{ concurrency: 4 },
			);

			if (request.stills) {
				const target = resolve(
					request.output ?? defaultOutput(input, "frames", ""),
				);
				yield* fs.makeDirectory(target, { recursive: true });
				const frames = yield* Effect.forEach(stills, (still, i) => {
					const path = join(
						target,
						`frame-${String(i + 1).padStart(3, "0")}.jpg`,
					);
					return fs
						.copyFile(still, path)
						.pipe(Effect.as({ time: times[i] as number, path }));
				});
				return { output: target, width, frames };
			}

			const output = resolve(
				request.output ?? defaultOutput(input, "frames", ".jpg"),
			);
			const grid = gridFor(times.length, request.columns);
			yield* atomically(output, input, (partial) =>
				ffmpeg(
					sheetArgs({
						pattern: join(dir, `%03d${ext}`),
						output: partial,
						...grid,
					}),
					"tile the contact sheet",
				),
			);
			// An image has no duration worth reporting (ffprobe says 0.04 s).
			const { duration: _, ...written } = yield* report(output);
			return {
				...written,
				...grid,
				frames: times.map((time) => ({ time })),
			};
		}, finish),

		audio: Effect.fn("Media.audio")(function* (request: AudioRequest) {
			const input = resolve(request.input);
			const info = yield* probe(input);
			if (info.audio === undefined) {
				return yield* Effect.fail(
					new MediaError({ reason: `${input} has no audio track.` }),
				);
			}
			yield* checkWindow(info, request.from, request.to);
			const codec = info.audio.codec;
			const output = resolve(
				request.output ??
					(request.transcription
						? defaultOutput(input, "16k", ".flac")
						: defaultOutput(input, null, audioExtension(codec))),
			);
			const ext = extname(output).toLowerCase();
			if (request.transcription && ext !== ".flac") {
				return yield* Effect.fail(
					new MediaError({
						reason: `--for-transcription writes FLAC: give -o a .flac path, not ${basename(output)}.`,
					}),
				);
			}
			if (
				request.transcription &&
				(request.from !== undefined || request.to !== undefined)
			) {
				return yield* Effect.fail(
					new MediaError({
						reason:
							"--for-transcription takes the whole track; cut first with --from/--to without it, or with infer media trim.",
					}),
				);
			}
			const copied = !request.transcription && canCopyAudio(codec, ext);
			yield* Console.error(
				`${copied ? "Copying" : "Encoding"} the audio track to ${basename(output)}...`,
			);
			yield* atomically(output, input, (partial) =>
				ffmpeg(
					request.transcription
						? transcriptionArgs(input, partial)
						: audioArgs({
								input,
								output: partial,
								codec,
								...(request.from !== undefined ? { from: request.from } : {}),
								...(request.to !== undefined ? { to: request.to } : {}),
							}),
					`extract the audio of ${basename(input)}`,
				),
			);
			const written = yield* probe(output);
			return {
				output,
				...(written.duration !== undefined
					? { duration: written.duration }
					: {}),
				...(written.size !== undefined ? { size: written.size } : {}),
				...(written.audio?.codec !== undefined
					? { codec: written.audio.codec }
					: {}),
				...(written.audio?.sampleRate !== undefined
					? { sampleRate: written.audio.sampleRate }
					: {}),
				...(written.audio?.channels !== undefined
					? { channels: written.audio.channels }
					: {}),
				copied,
			};
		}, finish),
	};
};

export const layer: Layer.Layer<Media, never, Platform> = Layer.effect(Media)(
	Effect.gen(function* () {
		return make(yield* Effect.context<Platform>());
	}),
);
