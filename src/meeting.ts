/**
 * `infer meeting` — record the microphone and system audio as two tracks,
 * transcribe each, and merge them into one transcript labelled by speaker.
 * Cleaning it up or summarising it is left to whoever reads it — usually the
 * agent that ran the command.
 *
 * Capture is a small Swift helper on ScreenCaptureKit (macOS 15+), compiled
 * on first use and cached by the hash of its source. ffmpeg cannot hear system
 * audio on macOS without a virtual driver such as BlackHole.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	Console,
	Data,
	Deferred,
	Effect,
	FileSystem,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect";
import { ChildProcess } from "effect/process";
import { Groq } from "./groq.ts";
// @ts-expect-error text import: Bun inlines the file contents as a string
import captureSource from "./meeting/capture.swift" with { type: "text" };
import { cacheDir, run } from "./stage.ts";
import {
	frameLevels,
	SAMPLE_RATE,
	speechRegions,
	splice,
	toOriginal,
} from "./vad.ts";

export class MeetingError extends Data.TaggedError("MeetingError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

const fail = (reason: string) => Effect.fail(new MeetingError({ reason }));

// --- Capture ---------------------------------------------------------------

/** The helper's stdout protocol, one JSON object per line. */
const CaptureMessage = Schema.Union([
	Schema.Struct({ type: Schema.Literal("started") }),
	Schema.Struct({
		type: Schema.Literal("stopped"),
		reason: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
	Schema.Struct({ type: Schema.Literal("warning"), message: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("level"),
		mic: Schema.Number,
		system: Schema.Number,
	}),
]);
const decodeMessage = Schema.decodeUnknownOption(
	Schema.fromJsonString(CaptureMessage),
);

/** What the helper leaves in `capture.json`: when each track's audio began. */
const CaptureInfo = Schema.Struct({
	systemStart: Schema.optionalKey(Schema.Number),
	micStart: Schema.optionalKey(Schema.Number),
});

// --- Level meter -------------------------------------------------------------

/** Quieter than this counts as silence: room noise sits around -60 to -55. */
const SILENCE_DB = -50;
/** A track silent this long is flagged, in case it is not being captured. */
const SILENCE_WARN_MS = 30_000;

const clock = (seconds: number): string => {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

const bar = (decibels: number, cells: number): string => {
	const filled = Math.round(
		Math.min(1, Math.max(0, (decibels + 60) / 60)) * cells,
	);
	return `\x1b[32m${"█".repeat(filled)}\x1b[2m${"·".repeat(cells - filled)}\x1b[0m`;
};

export interface MeterTrack {
	readonly label: string;
	readonly decibels: number;
	/** How long the track has been below the silence threshold. */
	readonly silentMs: number;
}

/**
 * One status line: elapsed time and a bar per track, with a track that has
 * been silent for a while called out — the sign it may not be captured.
 */
export const meterLine = (
	elapsedMs: number,
	tracks: ReadonlyArray<MeterTrack>,
	columns: number,
): string => {
	const cells = columns >= 80 ? 16 : 8;
	const parts = tracks.map((track) => {
		const note =
			track.silentMs >= SILENCE_WARN_MS
				? ` \x1b[33msilent ${clock(track.silentMs / 1000)}\x1b[0m`
				: "";
		return `${track.label} ${bar(track.decibels, cells)}${note}`;
	});
	return `\x1b[31m●\x1b[0m ${clock(elapsedMs / 1000)}  ${parts.join("  ")}`;
};

/** Compiles the capture helper once per version of its source. */
const helper = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const hash = createHash("sha256")
		.update(captureSource as string)
		.digest("hex")
		.slice(0, 12);
	const dir = join(cacheDir(), "meeting", hash);
	const binary = join(dir, "capture");
	if (yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false))) {
		return binary;
	}
	if (process.platform !== "darwin") {
		return yield* fail("infer meeting records on macOS only, for now.");
	}
	yield* fs
		.makeDirectory(dir, { recursive: true })
		.pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));
	const source = join(dir, "capture.swift");
	yield* fs
		.writeFileString(source, captureSource as string)
		.pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));
	yield* Console.error("Compiling the audio capture helper (once)...");
	const result = yield* run("swiftc", ["-O", source, "-o", binary], {
		stdout: "pipe",
		stderr: "pipe",
	}).pipe(
		Effect.mapError(
			() =>
				new MeetingError({
					reason:
						"Recording needs the Swift compiler. Install the Xcode Command Line Tools with `xcode-select --install`, then run again.",
				}),
		),
	);
	if (result.code !== 0) {
		return yield* fail(
			`Could not compile the capture helper:\n${result.stderr}`,
		);
	}
	return binary;
});

/**
 * Resolves on Enter or Ctrl-C. While waiting, Ctrl-C belongs to this wait
 * rather than to the runtime, which would otherwise interrupt the whole
 * command and lose the transcription: the runtime's listeners are set aside
 * and put back afterwards, so a second Ctrl-C during transcription aborts.
 */
const enterOrCtrlC = Effect.callback<void>((resume) => {
	const saved = process.listeners("SIGINT");
	process.removeAllListeners("SIGINT");
	const done = () => resume(Effect.void);
	process.once("SIGINT", done);
	const onData = () => done();
	if (process.stdin.isTTY) {
		process.stdin.once("data", onData);
		process.stdin.resume();
	}
	return Effect.sync(() => {
		process.off("SIGINT", done);
		process.stdin.off("data", onData);
		process.stdin.pause();
		for (const listener of saved) process.on("SIGINT", listener);
	});
});

export interface RecordOptions {
	readonly dir: string;
	/** Labels for the meter; the transcript sets its own. */
	readonly me: string;
	readonly them: string;
	/** Stop after this long; otherwise on Enter or Ctrl-C. */
	readonly durationMs?: number;
}

/** Records until stopped, leaving mic.caf, system.caf and capture.json. */
export const record = Effect.fn("Meeting.record")(function* (
	options: RecordOptions,
) {
	const binary = yield* helper;
	const fs = yield* FileSystem.FileSystem;
	yield* fs
		.makeDirectory(options.dir, { recursive: true })
		.pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));

	const capture = yield* ChildProcess.make(binary, [options.dir], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	}).pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));

	const started = yield* Deferred.make<void, MeetingError>();
	/** Completes with macOS's reason when the stream ended on its own. */
	const stopped = yield* Deferred.make<Option.Option<string>, MeetingError>();
	// The meter redraws one line in place, so only on a terminal; it is off
	// until recording starts and after it stops.
	const live = process.stderr.isTTY === true;
	const meter = yield* Ref.make(
		Option.none<{
			began: number;
			micLoud: number;
			systemLoud: number;
			/** When the helper last reported levels: proof it is alive. */
			heard: number;
		}>(),
	);
	const drawLevels = (mic: number, system: number) =>
		Ref.get(meter).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (state) =>
						Effect.gen(function* () {
							const now = Date.now();
							const next = {
								...state,
								heard: now,
								micLoud: mic > SILENCE_DB ? now : state.micLoud,
								systemLoud: system > SILENCE_DB ? now : state.systemLoud,
							};
							yield* Ref.set(meter, Option.some(next));
							const line = meterLine(
								now - state.began,
								[
									{
										label: options.me,
										decibels: mic,
										silentMs: now - next.micLoud,
									},
									{
										label: options.them,
										decibels: system,
										silentMs: now - next.systemLoud,
									},
								],
								process.stderr.columns ?? 80,
							);
							yield* Effect.sync(() =>
								process.stderr.write(`\r\x1b[2K${line}`),
							);
						}),
				}),
			),
		);
	yield* capture.stdout.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.runForEach((line) =>
			Option.match(decodeMessage(line), {
				onNone: () => Effect.void,
				onSome: (message) => {
					switch (message.type) {
						case "started":
							return Deferred.succeed(started, undefined);
						case "stopped":
							return Deferred.succeed(
								stopped,
								Option.fromUndefinedOr(message.reason),
							);
						case "warning":
							return Console.error(`warning: ${message.message}`);
						case "level":
							return live
								? drawLevels(message.mic, message.system)
								: Effect.void;
						case "error": {
							const error = new MeetingError({ reason: message.message });
							return Effect.all([
								Deferred.fail(started, error),
								Deferred.fail(stopped, error),
							]);
						}
					}
				},
			}),
		),
		Effect.ignore,
		Effect.forkScoped,
	);

	yield* Effect.raceFirst(
		Deferred.await(started),
		// Exited first: its last line, already read, usually says why.
		capture.exitCode.pipe(
			Effect.mapError((e) => new MeetingError({ reason: e.message })),
			Effect.andThen(
				Deferred.await(started).pipe(
					Effect.timeoutOrElse({
						duration: "1 second",
						orElse: () => fail("The capture helper exited before recording."),
					}),
				),
			),
		),
	);
	const began = Date.now();
	yield* Console.error(
		`Recording mic + system audio to ${options.dir}\n${
			options.durationMs === undefined
				? "Press Enter or Ctrl-C to stop."
				: `Stopping after ${Math.round(options.durationMs / 1000)} s (Enter or Ctrl-C stops sooner).`
		}`,
	);
	yield* Ref.set(
		meter,
		Option.some({ began, micLoud: began, systemLoud: began, heard: began }),
	);
	// Levels arrive five times a second; a gap means the helper stalled, which
	// the meter would otherwise hide by simply freezing.
	if (live) {
		yield* Ref.get(meter).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (state) => {
						const quiet = Date.now() - state.heard;
						return quiet < 3000
							? Effect.void
							: Effect.sync(() =>
									process.stderr.write(
										`\r\x1b[2K\x1b[33m⚠ No audio from the recorder for ${Math.round(quiet / 1000)} s\x1b[0m`,
									),
								);
					},
				}),
			),
			Effect.repeat(Schedule.spaced("1 second")),
			Effect.forkScoped,
		);
	}

	const asked =
		options.durationMs === undefined
			? enterOrCtrlC
			: Effect.raceFirst(enterOrCtrlC, Effect.sleep(options.durationMs));
	// Whichever comes first: the user, or the recording ending without them —
	// macOS stopping the stream, or the helper dying. Either way, what was
	// recorded is on disk and still gets transcribed.
	const ended = yield* Effect.raceFirst(
		asked.pipe(Effect.as(Option.none<string>())),
		Effect.raceFirst(
			Deferred.await(stopped).pipe(
				Effect.map((reason) =>
					Option.some(
						Option.getOrElse(reason, () => "The recording ended by itself."),
					),
				),
			),
			capture.exitCode.pipe(
				Effect.map((code) =>
					Option.some(`The capture helper exited unexpectedly (code ${code}).`),
				),
				Effect.orElseSucceed(() =>
					Option.some("The capture helper exited unexpectedly."),
				),
			),
		),
	);

	yield* Ref.set(meter, Option.none());
	if (live) yield* Effect.sync(() => process.stderr.write("\r\x1b[2K"));
	if (Option.isNone(ended)) {
		yield* Stream.make(new TextEncoder().encode("stop\n")).pipe(
			Stream.run(capture.stdin),
			Effect.ignore,
		);
		yield* Deferred.await(stopped).pipe(
			Effect.timeoutOrElse({
				duration: "10 seconds",
				orElse: () => fail("The capture helper did not stop cleanly."),
			}),
		);
	}
	const minutes = ((Date.now() - began) / 60_000).toFixed(1);
	yield* Option.match(ended, {
		onNone: () => Console.error(`■ Stopped after ${minutes} min.`),
		onSome: (reason) =>
			Console.error(
				`■ ${reason} Recorded ${minutes} min; transcribing what was captured.`,
			),
	});
});

// --- Transcript ------------------------------------------------------------

const Segment = Schema.Struct({
	start: Schema.Number,
	end: Schema.Number,
	text: Schema.String,
	no_speech_prob: Schema.optionalKey(Schema.Number),
});
export type Segment = typeof Segment.Type;
const Verbose = Schema.fromJsonString(
	Schema.Struct({
		/** The detected language, as an English name: "French". */
		language: Schema.optionalKey(Schema.String),
		segments: Schema.Array(Segment),
	}),
);

/**
 * The ISO-639-1 code for a language name as Whisper reports it ("French" →
 * "fr"), found by asking Intl for the English name of every two-letter code.
 */
export const languageCode = (name: string): string | undefined => {
	const names = new Intl.DisplayNames(["en"], { type: "language" });
	const wanted = name.trim().toLowerCase();
	const letters = "abcdefghijklmnopqrstuvwxyz";
	for (const a of letters) {
		for (const b of letters) {
			const code = a + b;
			if (names.of(code)?.toLowerCase() === wanted) return code;
		}
	}
	return undefined;
};

export interface Turn {
	readonly speaker: string;
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

const words = (text: string): ReadonlySet<string> =>
	new Set(
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, "")
			.split(/\s+/)
			.filter((word) => word.length > 0),
	);

/** How much of `a`'s vocabulary also appears in `b`. */
const overlap = (a: string, b: string): number => {
	const wa = words(a);
	if (wa.size === 0) return 0;
	const wb = words(b);
	let shared = 0;
	for (const word of wa) if (wb.has(word)) shared++;
	return shared / wa.size;
};

/**
 * Merges the two tracks into one time-ordered list of turns.
 *
 * Whisper invents text over silence ("Thank you."), so segments it marks as
 * probably silent are dropped. On speakers rather than headphones the mic
 * also hears the other side; a mic segment that mostly repeats system audio
 * at the same moment is that echo, and is dropped. Consecutive segments from
 * the same speaker become one turn.
 */
export const mergeTracks = (
	tracks: ReadonlyArray<{
		readonly speaker: string;
		readonly offset: number;
		readonly segments: ReadonlyArray<Segment>;
		readonly echoOf?: string;
	}>,
): ReadonlyArray<Turn> => {
	const shifted = tracks.map((track) => ({
		...track,
		turns: track.segments
			.filter((segment) => (segment.no_speech_prob ?? 0) < 0.6)
			.map((segment) => ({
				speaker: track.speaker,
				start: segment.start + track.offset,
				end: segment.end + track.offset,
				text: segment.text.trim(),
			}))
			.filter((turn) => /[^\s.…]/.test(turn.text)),
	}));
	const all = shifted.flatMap((track) => {
		if (track.echoOf === undefined) return track.turns;
		const other = shifted.find((t) => t.speaker === track.echoOf)?.turns ?? [];
		// Whisper splits the two tracks differently, so a mic segment is
		// compared with everything the system track said around it.
		return track.turns.filter((turn) => {
			const around = other
				.filter((o) => o.start < turn.end + 2 && turn.start < o.end + 2)
				.map((o) => o.text)
				.join(" ");
			return overlap(turn.text, around) <= 0.6;
		});
	});
	const sorted = [...all].sort((a, b) => a.start - b.start);
	const merged: Array<Turn> = [];
	for (const turn of sorted) {
		const last = merged.at(-1);
		if (last && last.speaker === turn.speaker && turn.start - last.end < 4) {
			merged[merged.length - 1] = {
				...last,
				end: Math.max(last.end, turn.end),
				text: `${last.text} ${turn.text}`,
			};
		} else merged.push(turn);
	}
	return merged;
};

export const formatTranscript = (turns: ReadonlyArray<Turn>): string =>
	turns
		.map((turn) => `[${clock(turn.start)}] **${turn.speaker}:** ${turn.text}`)
		.join("\n\n");

export interface TranscribeOptions {
	readonly dir: string;
	readonly language?: string;
	readonly me: string;
	readonly them: string;
}

/** Transcribes both tracks of a recording into transcript.md and .json. */
export const transcribe = Effect.fn("Meeting.transcribe")(function* (
	options: TranscribeOptions,
) {
	const fs = yield* FileSystem.FileSystem;
	const groq = yield* Groq;
	const info = yield* fs.readFileString(join(options.dir, "capture.json")).pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(Schema.fromJsonString(CaptureInfo)),
		),
		Effect.orElseSucceed(() => ({}) as typeof CaptureInfo.Type),
	);
	const tracks = [
		{ name: "system", speaker: options.them, start: info.systemStart },
		{ name: "mic", speaker: options.me, start: info.micStart },
	];
	const present = yield* Effect.filter(tracks, (track) =>
		fs.stat(join(options.dir, `${track.name}.caf`)).pipe(
			Effect.map((stat) => Number(stat.size) > 4096),
			Effect.orElseSucceed(() => false),
		),
	);
	if (present.length === 0) {
		return yield* fail(`No recording found in ${options.dir}.`);
	}
	const origin = Math.min(
		...present.map((track) => track.start ?? Number.POSITIVE_INFINITY),
	);

	yield* Console.error("Transcribing...");
	// Without --language, the other side's track — which carries most of the
	// talk — is transcribed first and its language reused for the mic, whose
	// stretches of near-silence otherwise get misdetected (French heard as
	// English, with invented English filler).
	const detected = yield* Ref.make(Option.none<string>());
	const transcribed = yield* Effect.forEach(
		present,
		(track) =>
			Effect.gen(function* () {
				const input = join(options.dir, `${track.name}.caf`);
				const compressed = join(options.dir, `${track.name}.ogg`);
				const pcm = join(options.dir, `.${track.name}.pcm`);
				const ffmpeg = (args: ReadonlyArray<string>) =>
					run("ffmpeg", ["-v", "error", ...args], {
						stdout: "ignore",
						stderr: "pipe",
					}).pipe(
						Effect.mapError((e) => new MeetingError({ reason: e.message })),
						Effect.flatMap((result) =>
							result.code === 0
								? Effect.void
								: fail(`ffmpeg failed on ${input}:\n${result.stderr}`),
						),
					);
				const io = <A, E extends { readonly message: string }>(
					effect: Effect.Effect<A, E>,
				) =>
					effect.pipe(
						Effect.mapError((e) => new MeetingError({ reason: e.message })),
					);

				// Only speech is sent: silence is where Whisper invents "Merci."
				// The track is decoded to raw 16 kHz samples, its speech found
				// and spliced together, and the result encoded for upload.
				yield* ffmpeg([
					"-i",
					input,
					"-ar",
					String(SAMPLE_RATE),
					"-ac",
					"1",
					"-f",
					"s16le",
					"-y",
					pcm,
				]);
				const bytes = yield* io(fs.readFile(pcm));
				const samples = new Int16Array(
					bytes.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + (bytes.byteLength & ~1),
					),
				);
				const regions = speechRegions(frameLevels(samples));
				const { audio, map } = splice(samples, regions);
				const speech = audio.length / SAMPLE_RATE;
				const total = samples.length / SAMPLE_RATE;
				yield* Console.error(
					`  ${track.speaker}: ${clock(speech)} of speech in ${clock(total)}`,
				);
				const base = {
					speaker: track.speaker,
					offset:
						track.start !== undefined && Number.isFinite(origin)
							? track.start - origin
							: 0,
					...(track.name === "mic" ? { echoOf: options.them } : {}),
				};
				if (audio.length === 0) {
					yield* io(fs.remove(pcm));
					return { ...base, segments: [] as ReadonlyArray<Segment> };
				}
				yield* io(
					fs.writeFile(
						pcm,
						new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
					),
				);
				// 16 kHz mono Opus: what Whisper hears anyway, at about 11 MB
				// an hour of speech, under Groq's 25 MB upload.
				yield* ffmpeg([
					"-f",
					"s16le",
					"-ar",
					String(SAMPLE_RATE),
					"-ac",
					"1",
					"-i",
					pcm,
					"-c:a",
					"libopus",
					"-b:a",
					"24k",
					"-y",
					compressed,
				]);
				yield* io(fs.remove(pcm));
				const body = yield* groq
					.transcribe({
						file: compressed,
						model: "whisper-large-v3-turbo",
						language:
							options.language ??
							Option.getOrUndefined(yield* Ref.get(detected)),
						responseFormat: "verbose_json",
						granularities: ["segment"],
						optimize: false,
					})
					.pipe(
						Effect.mapError((e) => new MeetingError({ reason: e.message })),
					);
				const parsed = yield* Schema.decodeUnknownEffect(Verbose)(body).pipe(
					Effect.mapError(
						() =>
							new MeetingError({
								reason: `Groq returned no segments for the ${track.name} track.`,
							}),
					),
				);
				// Back on the meeting's clock: Whisper timed the spliced audio.
				const segments = parsed.segments.map((segment) => ({
					...segment,
					start: toOriginal(segment.start, map),
					end: toOriginal(segment.end, map),
				}));
				// Kept per track: every segment Whisper returned, with its
				// timing and confidence, before echoes are removed and the
				// tracks merged — plus where speech was found.
				yield* io(
					fs.writeFileString(
						join(options.dir, `${track.name}.transcript.json`),
						JSON.stringify(
							{
								language: parsed.language,
								seconds: total,
								speechSeconds: speech,
								speech: regions,
								segments,
							},
							null,
							2,
						),
					),
				);
				if (parsed.language !== undefined) {
					const code = languageCode(parsed.language);
					if (code !== undefined && Option.isNone(yield* Ref.get(detected))) {
						yield* Ref.set(detected, Option.some(code));
					}
				}
				return { ...base, segments };
			}),
		{ concurrency: 1 },
	);

	const turns = mergeTracks(transcribed);
	const markdown = `# Transcript\n\n${formatTranscript(turns)}\n`;
	yield* fs
		.writeFileString(join(options.dir, "transcript.md"), markdown)
		.pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));
	yield* fs
		.writeFileString(
			join(options.dir, "transcript.json"),
			JSON.stringify(turns, null, 2),
		)
		.pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));
	return { turns, markdown };
});
