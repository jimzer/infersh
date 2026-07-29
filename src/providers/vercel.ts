/**
 * Vercel AI Gateway provider — text generation and structured output
 * via Vercel's OpenAI-compatible Responses API.
 */

import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import OpenAI from "openai";

const BASE_URL = "https://ai-gateway.vercel.sh/v1";

// --- Schema ---

const GenerateInput = Schema.Struct({
	model: Schema.String,
	input: Schema.String,
	schema_name: Schema.optionalKey(Schema.String),
	schema: Schema.optionalKey(Schema.String),
	schema_description: Schema.optionalKey(Schema.String),
	temperature: Schema.optionalKey(Schema.Number),
	max_tokens: Schema.optionalKey(Schema.Number),
	top_p: Schema.optionalKey(Schema.Number),
});

// --- Helpers ---

function apiKey(): string {
	const key = process.env.VERCEL_API_KEY ?? process.env.AI_GATEWAY_API_KEY;
	if (!key) {
		console.error(
			"VERCEL_API_KEY or AI_GATEWAY_API_KEY environment variable is required",
		);
		process.exit(1);
	}
	return key;
}

function client(): OpenAI {
	return new OpenAI({ apiKey: apiKey(), baseURL: BASE_URL });
}

function callGenerate(params: {
	model: string;
	input: string;
	schema_name?: string;
	schema?: string;
	schema_description?: string;
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
}): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		const body: Record<string, unknown> = {
			model: params.model,
			input: params.input,
		};

		if (params.temperature !== undefined) body.temperature = params.temperature;
		if (params.max_tokens !== undefined)
			body.max_output_tokens = params.max_tokens;
		if (params.top_p !== undefined) body.top_p = params.top_p;

		if (params.schema && params.schema_name) {
			const schemaObj = JSON.parse(params.schema);
			body.text = {
				format: {
					type: "json_schema",
					name: params.schema_name,
					schema: schemaObj,
					...(params.schema_description
						? { description: params.schema_description }
						: {}),
				},
			};
		}

		const c = client();
		const response = yield* Effect.tryPromise({
			try: () =>
				c.responses.create({
					...(body as Parameters<typeof c.responses.create>[0]),
					stream: false,
				}),
			catch: (e) => new Error(`${e}`),
		});

		return response.output_text;
	});
}

// --- JSON subcommand ---

const generateJsonCmd = Command.make(
	"json",
	{ payload: Argument.string("payload").pipe(Argument.optional) },
	(config) =>
		Effect.gen(function* () {
			if (Option.isNone(config.payload)) {
				yield* Console.log(
					JSON.stringify(
						Schema.toJsonSchemaDocument(GenerateInput).schema,
						null,
						2,
					),
				);
				return;
			}
			const parsed = Schema.decodeUnknownSync(GenerateInput)(
				JSON.parse(config.payload.value),
			);
			const result = yield* callGenerate(parsed);
			yield* Console.log(result);
		}),
);

// --- Generate command ---

const GENERATE_DESCRIPTION = `Generate text or structured output using Vercel AI Gateway.

Uses the OpenAI-compatible Responses API via ai-gateway.vercel.sh.

Models use provider/model format (e.g. openai/gpt-4o, anthropic/claude-sonnet-4-20250514).
Set VERCEL_API_KEY or AI_GATEWAY_API_KEY env var.

For structured output, provide both --schema-name and --schema (JSON schema string).`;

const generateCmd = Command.make(
	"generate",
	{
		model: Flag.string("model").pipe(
			Flag.withDescription("Model to use, e.g. openai/gpt-4o"),
		),
		input: Flag.string("input").pipe(Flag.withDescription("Input prompt text")),
		schemaName: Flag.string("schema-name").pipe(
			Flag.optional,
			Flag.withDescription(
				"Name for the JSON schema (enables structured output)",
			),
		),
		schema: Flag.string("schema").pipe(
			Flag.optional,
			Flag.withDescription(
				"JSON schema string for structured output (requires --schema-name)",
			),
		),
		schemaDescription: Flag.string("schema-description").pipe(
			Flag.optional,
			Flag.withDescription("Description for the JSON schema"),
		),
		temperature: Flag.float("temperature").pipe(
			Flag.optional,
			Flag.withDescription("Sampling temperature (0-2)"),
		),
		maxTokens: Flag.integer("max-tokens").pipe(
			Flag.optional,
			Flag.withDescription("Maximum output tokens"),
		),
		topP: Flag.float("top-p").pipe(
			Flag.optional,
			Flag.withDescription("Top-p (nucleus) sampling parameter"),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const result = yield* callGenerate({
				model: config.model,
				input: config.input,
				schema_name: Option.getOrUndefined(config.schemaName),
				schema: Option.getOrUndefined(config.schema),
				schema_description: Option.getOrUndefined(config.schemaDescription),
				temperature: Option.getOrUndefined(config.temperature),
				max_tokens: Option.getOrUndefined(config.maxTokens),
				top_p: Option.getOrUndefined(config.topP),
			});
			yield* Console.log(result);
		}),
)
	.pipe(Command.withSubcommands([generateJsonCmd]))
	.pipe(Command.withDescription(GENERATE_DESCRIPTION));

// --- Models command ---

const MODELS_DESCRIPTION = `List available models on Vercel AI Gateway.

Shows model IDs, types, context windows, and pricing info.
Set VERCEL_API_KEY or AI_GATEWAY_API_KEY env var.`;

const modelsCmd = Command.make("models", {}, () =>
	Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: () =>
				fetch(`${BASE_URL}/models`, {
					headers: { Authorization: `Bearer ${apiKey()}` },
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
		const body = JSON.parse(text);
		if (body.data && Array.isArray(body.data)) {
			for (const m of body.data) {
				const parts = [m.id];
				if (m.type) parts.push(`type=${m.type}`);
				if (m.context_window) parts.push(`ctx=${m.context_window}`);
				yield* Console.log(parts.join("  "));
			}
		} else {
			yield* Console.log(JSON.stringify(body, null, 2));
		}
	}),
).pipe(Command.withDescription(MODELS_DESCRIPTION));

// --- Top-level vercel command ---

const vercelCmd = Command.make("vercel").pipe(
	Command.withSubcommands([generateCmd, modelsCmd]),
);

export async function run(args: string[]): Promise<void> {
	await (
		Command.runWith(vercelCmd, { version: "0.1.0" })(
			args,
		) as Effect.Effect<void>
	).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
}
