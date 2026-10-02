/**
 * `infer meeting` — record the microphone and system audio as two tracks,
 * transcribe each, merge them into one transcript labelled by speaker, and
 * write clean notes.
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
	Schema,
	Stream,
} from "effect";
import { ChildProcess } from "effect/process";
import { Groq } from "./groq.ts";
import captureSource from "./meeting/capture.swift" with { type: "text" };
import { OpenRouter } from "./openrouter.ts";
import { cacheDir, run } from "./stage.ts";

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
	Schema.Struct({ type: Schema.Literal("stopped") }),
	Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
	Schema.Struct({ type: Schema.Literal("warning"), message: Schema.String }),
]);
const decodeMessage = Schema.decodeUnknownOption(
	Schema.fromJsonString(CaptureMessage),
);

/** What the helper leaves in `capture.json`: when each track's audio began. */
const CaptureInfo = Schema.Struct({
	systemStart: Schema.optionalKey(Schema.Number),
	micStart: Schema.optionalKey(Schema.Number),
});

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
	const stopped = yield* Deferred.make<void, MeetingError>();
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
							return Deferred.succeed(stopped, undefined);
						case "warning":
							return Console.error(`warning: ${message.message}`);
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
		`● Recording mic + system audio to ${options.dir}\n  ${
			options.durationMs === undefined
				? "Press Enter or Ctrl-C to stop."
				: `Stopping after ${Math.round(options.durationMs / 1000)} s (Enter or Ctrl-C stops sooner).`
		}`,
	);
	yield* options.durationMs === undefined
		? enterOrCtrlC
		: Effect.raceFirst(enterOrCtrlC, Effect.sleep(options.durationMs));

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
	const minutes = (Date.now() - began) / 60_000;
	yield* Console.error(`■ Stopped after ${minutes.toFixed(1)} min.`);
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
	Schema.Struct({ segments: Schema.Array(Segment) }),
);

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
			.filter((turn) => turn.text.length > 0),
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

const clock = (seconds: number): string => {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
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
	const transcribed = yield* Effect.forEach(
		present,
		(track) =>
			Effect.gen(function* () {
				const input = join(options.dir, `${track.name}.caf`);
				const compressed = join(options.dir, `${track.name}.ogg`);
				// 16 kHz mono Opus: what Whisper hears anyway, at about 11 MB
				// an hour, so a long meeting stays under Groq's 25 MB upload.
				const encoded = yield* run(
					"ffmpeg",
					[
						"-v",
						"error",
						"-i",
						input,
						"-ar",
						"16000",
						"-ac",
						"1",
						"-c:a",
						"libopus",
						"-b:a",
						"24k",
						"-y",
						compressed,
					],
					{ stdout: "ignore", stderr: "pipe" },
				).pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));
				if (encoded.code !== 0) {
					return yield* fail(`ffmpeg failed on ${input}:\n${encoded.stderr}`);
				}
				const body = yield* groq
					.transcribe({
						file: compressed,
						model: "whisper-large-v3-turbo",
						language: options.language,
						responseFormat: "verbose_json",
						granularities: ["segment"],
						optimize: false,
					})
					.pipe(
						Effect.mapError((e) => new MeetingError({ reason: e.message })),
					);
				// Groq's own response, kept per track: the raw material, with
				// every segment's timing and confidence, before any merging.
				yield* fs
					.writeFileString(
						join(options.dir, `${track.name}.transcript.json`),
						body,
					)
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
				return {
					speaker: track.speaker,
					offset:
						track.start !== undefined && Number.isFinite(origin)
							? track.start - origin
							: 0,
					segments: parsed.segments,
					...(track.name === "mic" ? { echoOf: options.them } : {}),
				};
			}),
		{ concurrency: 2 },
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

// --- Notes -----------------------------------------------------------------

const NOTES_INSTRUCTIONS = `You turn a raw meeting transcript into clean notes in Markdown.

The transcript comes from speech recognition on two tracks: one speaker is the
person who recorded it, the other label covers everyone else on the call.
Recognition errors are likely; fix obvious ones from context, never invent
content, and keep names, numbers and technical terms exactly as said.

Write, in this order:
# <a short title for the meeting>
## Summary — 3 to 6 bullets.
## Decisions — bullets; omit the section if none.
## Action items — "- [ ] who: what (when, if said)"; omit if none.
## Open questions — omit if none.
## Clean transcript — the whole conversation, same speaker labels and
timestamps, with filler words, false starts and repetitions removed and
punctuation fixed. Keep every point that was made.

Write everything in the language the meeting was held in: translate the section
headings above too (in French: Résumé, Décisions, Actions, Questions ouvertes,
Transcription).
Answer with the Markdown only.`;

export const notes = Effect.fn("Meeting.notes")(function* (
	dir: string,
	transcript: string,
	model: string,
) {
	const openrouter = yield* OpenRouter;
	const fs = yield* FileSystem.FileSystem;
	yield* Console.error(`Writing notes with ${model}...`);
	const result = yield* openrouter
		.respond({
			model,
			instructions: NOTES_INSTRUCTIONS,
			prompt: transcript,
			maxTokens: 32_000,
		})
		.pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));
	const path = join(dir, "notes.md");
	yield* fs
		.writeFileString(path, `${result.text.trim()}\n`)
		.pipe(Effect.mapError((e) => new MeetingError({ reason: e.message })));
	return path;
});
