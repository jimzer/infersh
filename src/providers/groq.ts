/**
 * Groq provider — Whisper speech-to-text via Groq API.
 */

import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

const API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"] as const;
const RESPONSE_FORMATS = ["json", "verbose_json", "text"] as const;
const TIMESTAMP_GRANULARITIES = ["segment", "word"] as const;

// --- Schema ---

const TranscribeInput = Schema.Struct({
	file: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	model: Schema.String,
	language: Schema.optionalKey(Schema.String),
	prompt: Schema.optionalKey(Schema.String),
	response_format: Schema.optionalKey(Schema.String),
	temperature: Schema.optionalKey(Schema.Number),
	timestamp_granularities: Schema.optionalKey(Schema.Array(Schema.String)),
});

function apiKey(): string {
	const key = process.env.GROQ_API_KEY;
	if (!key) {
		console.error("GROQ_API_KEY environment variable is required");
		process.exit(1);
	}
	return key;
}

function buildFormData(params: {
	file?: string;
	url?: string;
	model: string;
	language?: string;
	prompt?: string;
	response_format?: string;
	temperature?: number;
	timestamp_granularities?: readonly string[];
}): Effect.Effect<FormData, Error> {
	return Effect.gen(function* () {
		const form = new FormData();

		if (params.file) {
			const bunFile = Bun.file(params.file);
			const exists = yield* Effect.tryPromise({
				try: () => bunFile.exists(),
				catch: (e) => new Error(`${e}`),
			});
			if (!exists) {
				return yield* Effect.fail(new Error(`File not found: ${params.file}`));
			}
			form.append("file", bunFile);
		} else if (params.url) {
			form.append("url", params.url);
		} else {
			return yield* Effect.fail(
				new Error("Either --file or --url is required"),
			);
		}

		form.append("model", params.model);

		if (params.language) form.append("language", params.language);
		if (params.prompt) form.append("prompt", params.prompt);
		if (params.response_format)
			form.append("response_format", params.response_format);
		if (params.temperature !== undefined)
			form.append("temperature", String(params.temperature));
		if (params.timestamp_granularities) {
			for (const g of params.timestamp_granularities) {
				form.append("timestamp_granularities[]", g);
			}
		}

		return form;
	});
}

function callApi(form: FormData): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: () =>
				fetch(API_URL, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey()}` },
					body: form,
				}),
			catch: (e) => new Error(`${e}`),
		});
		const text = yield* Effect.tryPromise({
			try: () => res.text(),
			catch: (e) => new Error(`${e}`),
		});
		if (!res.ok) {
			return yield* Effect.fail(new Error(`API error ${res.status}: ${text}`));
		}
		return text;
	});
}

// --- JSON subcommand ---

const jsonCmd = Command.make(
	"json",
	{ payload: Argument.string("payload").pipe(Argument.optional) },
	(config) =>
		Effect.gen(function* () {
			if (Option.isNone(config.payload)) {
				yield* Console.log(
					JSON.stringify(
						Schema.toJsonSchemaDocument(TranscribeInput).schema,
						null,
						2,
					),
				);
				return;
			}
			const parsed = Schema.decodeUnknownSync(TranscribeInput)(
				JSON.parse(config.payload.value),
			);
			const form = yield* buildFormData(parsed);
			const result = yield* callApi(form);
			yield* Console.log(result);
		}),
);

// --- Main transcribe command ---

const DESCRIPTION = `Transcribe audio using Groq Whisper API.

Audio constraints:
  Max file size: 25 MB (free) / 100 MB (dev tier)
  Min duration: 0.01s — Min billed duration: 10s
  Supported formats: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm

ffmpeg preprocess (recommended):
  ffmpeg -i <input> -ar 16000 -ac 1 -map 0:a -c:a flac output.flac`;

export const transcribeCmd = Command.make(
	"transcribe",
	{
		file: Flag.string("file").pipe(Flag.optional),
		url: Flag.string("url").pipe(Flag.optional),
		model: Flag.choice("model", MODELS).pipe(Flag.optional),
		language: Flag.string("language").pipe(Flag.optional),
		prompt: Flag.string("prompt").pipe(Flag.optional),
		responseFormat: Flag.choice("response-format", RESPONSE_FORMATS).pipe(
			Flag.optional,
		),
		temperature: Flag.float("temperature").pipe(Flag.optional),
		timestampGranularities: Flag.choice(
			"timestamp-granularities",
			TIMESTAMP_GRANULARITIES,
		).pipe(Flag.optional),
	},
	(config) =>
		Effect.gen(function* () {
			const file = Option.getOrUndefined(config.file);
			const url = Option.getOrUndefined(config.url);
			const model = Option.getOrElse(
				config.model,
				() => "whisper-large-v3-turbo" as const,
			);

			const tg = Option.getOrUndefined(config.timestampGranularities);
			const form = yield* buildFormData({
				file,
				url,
				model,
				language: Option.getOrUndefined(config.language),
				prompt: Option.getOrUndefined(config.prompt),
				response_format: Option.getOrUndefined(config.responseFormat),
				temperature: Option.getOrUndefined(config.temperature),
				timestamp_granularities: tg ? [tg] : undefined,
			});
			const result = yield* callApi(form);
			yield* Console.log(result);
		}),
)
	.pipe(Command.withSubcommands([jsonCmd]))
	.pipe(Command.withDescription(DESCRIPTION));

// --- Top-level groq command ---

const groqCmd = Command.make("groq").pipe(
	Command.withSubcommands([transcribeCmd]),
);

export async function run(args: string[]): Promise<void> {
	await (
		Command.runWith(groqCmd, { version: "0.1.0" })(args) as Effect.Effect<void>
	).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
}
