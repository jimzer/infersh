/**
 * `infer groq` — speech-to-text via Groq's Whisper endpoints.
 */

import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { GRANULARITIES, Groq, MODELS, RESPONSE_FORMATS } from "../groq.ts";

const TRANSCRIBE_DESCRIPTION = `Transcribe speech from an audio or video file.

By default the audio is preprocessed with ffmpeg into 16 kHz mono FLAC
before upload. Groq downsamples to exactly that server-side anyway, so
this costs no accuracy while making large files far smaller — often the
difference between fitting the upload limit and not. Pass --no-optimize
to send the file untouched.

Limits worth knowing:
  Direct upload    25 MB. Larger files must be hosted and passed via --url.
  Minimum length   0.01s, but every request is billed as at least 10s.
  Audio tracks     Only the first track is transcribed, so a dubbed video
                   yields only its original language.
  Accepted formats flac, mp3, mp4, mpeg, mpga, m4a, ogg, opus, wav, webm.
                   Anything ffmpeg can read works when optimization is on.

Model choice: whisper-large-v3-turbo is the default — cheapest and
fastest, at roughly 12% word error rate. Use whisper-large-v3 when
accuracy matters more than cost (~10.3%, and the only one that also
supports translation).

Requires a Groq API key: run \`infer keys set\` or set GROQ_API_KEY.`;

const transcribeCmd = Command.make(
	"transcribe",
	{
		file: Flag.string("file").pipe(
			Flag.withMetavar("path"),
			Flag.optional,
			Flag.withDescription(
				"Local audio or video file to transcribe. Required unless --url is given. Preprocessed with ffmpeg unless --no-optimize is set.",
			),
		),
		url: Flag.string("url").pipe(
			Flag.withMetavar("url"),
			Flag.optional,
			Flag.withDescription(
				"Publicly reachable audio URL to transcribe instead of uploading. The only way to handle files over 25 MB; never preprocessed, since the file is never downloaded locally.",
			),
		),
		model: Flag.choice("model", MODELS).pipe(
			Flag.optional,
			Flag.withDescription(
				"Whisper model to use. Defaults to whisper-large-v3-turbo, the cheapest and fastest; whisper-large-v3 is more accurate.",
			),
		),
		language: Flag.string("language").pipe(
			Flag.withMetavar("code"),
			Flag.optional,
			Flag.withDescription(
				"ISO-639-1 code of the spoken language, e.g. en or fr. Supplying it improves both accuracy and latency; omit it to auto-detect.",
			),
		),
		prompt: Flag.string("prompt").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				"Style and context hint, max 224 tokens — the topic, or spellings of names and jargon. Guides wording only; it cannot issue instructions. Write it in the same language as the audio.",
			),
		),
		responseFormat: Flag.choice("response-format", RESPONSE_FORMATS).pipe(
			Flag.optional,
			Flag.withDescription(
				"json for the text plus metadata, text for bare text, verbose_json to also get per-segment timestamps and quality scores. Defaults to json.",
			),
		),
		temperature: Flag.float("temperature").pipe(
			Flag.withMetavar("0-1"),
			Flag.optional,
			Flag.withDescription(
				"Sampling temperature. 0, the default, is recommended for transcription.",
			),
		),
		timestampGranularities: Flag.choice(
			"timestamp-granularities",
			GRANULARITIES,
		).pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"Timestamp detail to include: segment for full metadata, word for word-level start and end times. Repeat the flag for both. Requires --response-format verbose_json.",
			),
		),
		noOptimize: Flag.boolean("no-optimize").pipe(
			Flag.withDescription(
				"Upload the file exactly as-is, skipping the ffmpeg 16 kHz mono FLAC conversion. Use when the file is already prepared, or when ffmpeg is unavailable.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const groq = yield* Groq;
			const result = yield* groq.transcribe({
				file: Option.getOrUndefined(config.file),
				url: Option.getOrUndefined(config.url),
				model: Option.getOrElse(
					config.model,
					() => "whisper-large-v3-turbo" as const,
				),
				language: Option.getOrUndefined(config.language),
				prompt: Option.getOrUndefined(config.prompt),
				responseFormat: Option.getOrUndefined(config.responseFormat),
				temperature: Option.getOrUndefined(config.temperature),
				granularities: config.timestampGranularities,
				optimize: !config.noOptimize,
			});
			yield* Console.log(result);
		}),
).pipe(
	Command.withShortDescription("Transcribe audio to text."),
	Command.withDescription(TRANSCRIBE_DESCRIPTION),
	Command.withExamples([
		{
			command: "infer groq transcribe --file talk.m4a",
			description: "Transcribe a local file",
		},
		{
			command: "infer groq transcribe --file talk.m4a --language en",
			description: "Name the language for better accuracy and latency",
		},
		{
			command:
				"infer groq transcribe --file talk.m4a --response-format text | pbcopy",
			description: "Get bare text with no JSON wrapper",
		},
		{
			command:
				"infer groq transcribe --file talk.m4a --response-format verbose_json --timestamp-granularities word",
			description: "Get word-level timestamps",
		},
		{
			command:
				"infer groq transcribe --url https://example.com/long.mp3 --model whisper-large-v3",
			description: "Transcribe a hosted file too large to upload",
		},
	]),
);

export const groqCmd = Command.make("groq").pipe(
	Command.withShortDescription("Speech-to-text with Groq Whisper."),
	Command.withDescription(
		`Speech-to-text using Groq's hosted Whisper models.

Audio is preprocessed with ffmpeg by default so that large recordings
fit the upload limit without losing transcription quality.`,
	),
	Command.withSubcommands([transcribeCmd]),
);
