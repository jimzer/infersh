/**
 * `infer meeting` — record a meeting and transcribe it.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { record, transcribe } from "../meeting.ts";
import { emitJson, jsonFlag } from "../output.ts";

/**
 * ~/Documents/infer/meetings/2026-10-02-1430, in local time. Outside the
 * working directory on purpose: a recording is private and large, and one
 * started from inside a repository must not end up in its commits.
 */
const defaultDir = (now: Date): string => {
	const pad = (n: number) => String(n).padStart(2, "0");
	return join(
		homedir(),
		"Documents",
		"infer",
		"meetings",
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`,
	);
};

export const meetingCmd = Command.make(
	"meeting",
	{
		out: Flag.String("out").pipe(
			Flag.withAlias("o"),
			Flag.withMetavar("dir"),
			Flag.optional,
			Flag.withDescription(
				"Folder for the recording and transcript. Defaults to ~/Documents/infer/meetings/<date-time>.",
			),
		),
		from: Flag.String("from").pipe(
			Flag.withMetavar("dir"),
			Flag.optional,
			Flag.withDescription(
				"Skip recording: transcribe a folder recorded earlier, e.g. after an interrupted run.",
			),
		),
		duration: Flag.Finite("duration").pipe(
			Flag.withMetavar("minutes"),
			Flag.optional,
			Flag.withDescription(
				"Stop recording after this many minutes. Without it, recording stops on Enter or Ctrl-C.",
			),
		),
		language: Flag.String("language").pipe(
			Flag.withMetavar("code"),
			Flag.optional,
			Flag.withDescription(
				"Spoken language as ISO-639-1, e.g. en or fr. Detected per track when omitted.",
			),
		),
		me: Flag.String("me").pipe(
			Flag.withMetavar("name"),
			Flag.withDefault("Me"),
			Flag.withDescription("Label for the microphone track."),
		),
		them: Flag.String("them").pipe(
			Flag.withMetavar("name"),
			Flag.withDefault("Them"),
			Flag.withDescription(
				"Label for the system audio track: everyone else on the call.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const dir = resolve(
				Option.getOrElse(config.from, () =>
					Option.getOrElse(config.out, () => defaultDir(new Date())),
				),
			);
			if (Option.isNone(config.from)) {
				yield* Effect.scoped(
					record({
						dir,
						me: config.me,
						them: config.them,
						durationMs: Option.getOrUndefined(
							Option.map(config.duration, (minutes) => minutes * 60_000),
						),
					}),
				).pipe(
					Effect.onInterrupt(() =>
						Console.error(
							`Recording kept in ${dir}. Transcribe it with: infer meeting --from ${dir}`,
						),
					),
				);
			}
			const { turns } = yield* transcribe({
				dir,
				language: Option.getOrUndefined(config.language),
				me: config.me,
				them: config.them,
			}).pipe(
				Effect.tapError(() =>
					Console.error(
						`The recording is kept in ${dir}; retry with: infer meeting --from ${dir}`,
					),
				),
			);
			const transcriptPath = join(dir, "transcript.md");
			if (config.json) {
				return yield* emitJson({
					dir,
					transcript: transcriptPath,
					turns: turns.length,
				});
			}
			yield* Console.log(transcriptPath);
		}),
).pipe(
	Command.withShortDescription(
		"Record a meeting (mic + system audio) and transcribe it.",
	),
	Command.withDescription(
		`Record your microphone and the computer's audio as two separate
tracks, then transcribe each with Groq Whisper and merge them into one
transcript where the mic is "Me" and system audio is "Them" — speaker
labels without diarization. The transcript is left as recognised:
cleaning it up, summarising it or pulling out action items is for
whoever reads it next.

macOS 15+ only. The first run compiles a small Swift helper (needs the
Xcode Command Line Tools) and macOS asks to allow your terminal under
Screen & System Audio Recording and Microphone.

Recording stops on Enter or Ctrl-C (or after --duration). Audio is
written to disk as it records, so an interrupted run loses nothing: run
again with --from <dir>. On speakers rather than headphones the mic also
hears the other side; those echoes are dropped from "Me" when they repeat
what "Them" said at the same moment.

Writes into the folder:
  mic.caf, system.caf                   the two tracks as recorded
  mic.ogg, system.ogg                   compressed copies, as uploaded
  mic.transcript.json, system.transcript.json
                                        Groq's raw response per track
  transcript.md, transcript.json        both tracks merged by time
stdout is the path of transcript.md.

Requires a Groq API key.`,
	),
	Command.withExamples([
		{
			command: "infer meeting",
			description: "Record until Enter or Ctrl-C, then transcribe",
		},
		{
			command: "infer meeting --me Jimi --them Client --language en",
			description: "Name the two sides",
		},
		{
			command:
				"infer meeting --from ~/Documents/infer/meetings/2026-10-02-1430",
			description: "Transcribe a recording made earlier",
		},
	]),
);
