/**
 * `infer openrouter` — run a prompt through any model on OpenRouter.
 */

import { readFileSync } from "node:fs";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { OpenRouter, OpenRouterError } from "../openrouter.ts";
import { emitJson, jsonFlag } from "../output.ts";

/** `--schema` takes JSON inline or `@path`, since schemas outgrow a shell arg. */
const readSchema = (raw: string): Effect.Effect<unknown, OpenRouterError> =>
	Effect.gen(function* () {
		const source = raw.startsWith("@")
			? yield* Effect.try({
					try: () => readFileSync(raw.slice(1), "utf8"),
					catch: (cause) =>
						new OpenRouterError({
							reason: `Could not read the schema file ${raw.slice(1)}: ${cause}`,
						}),
				})
			: raw;
		return yield* Effect.try({
			try: () => JSON.parse(source) as unknown,
			catch: (cause) =>
				new OpenRouterError({ reason: `--schema is not valid JSON: ${cause}` }),
		});
	});

const responseCmd = Command.make(
	"response",
	{
		model: Argument.string("model").pipe(
			Argument.withDescription(
				"Which model to run, as an OpenRouter slug such as anthropic/claude-sonnet-5 or x-ai/grok-4.5. Browse them at https://openrouter.ai/models.",
			),
		),
		prompt: Flag.string("prompt").pipe(
			Flag.withMetavar("text"),
			Flag.withDescription(
				"The prompt to send. Required. The endpoint is stateless, so this is the whole conversation.",
			),
		),
		schema: Flag.string("schema").pipe(
			Flag.withMetavar("json"),
			Flag.optional,
			Flag.withDescription(
				'A JSON Schema the answer must match, inline or as @path/to/schema.json. The top level must be {"type":"object"}. When set, stdout is the JSON object itself, so it pipes straight into jq.',
			),
		),
		schemaName: Flag.string("schema-name").pipe(
			Flag.withMetavar("name"),
			Flag.optional,
			Flag.withDescription(
				"Name reported to the provider alongside --schema. Cosmetic; defaults to `output`.",
			),
		),
		instructions: Flag.string("instructions").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				"System-level instructions applied ahead of the prompt, for setting a role or output style.",
			),
		),
		maxTokens: Flag.integer("max-tokens").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Cap on tokens generated. Reasoning models spend these before writing an answer, so allow headroom or the reply may be cut short.",
			),
		),
		temperature: Flag.float("temperature").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Sampling temperature. Lower is more deterministic; omit to use the model's own default.",
			),
		),
		reasoning: Flag.boolean("reasoning").pipe(
			Flag.withDescription(
				"Also print the model's reasoning block to stderr, when it produced one.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const openrouter = yield* OpenRouter;

			const schema = Option.isSome(config.schema)
				? yield* readSchema(config.schema.value)
				: undefined;

			const result = yield* openrouter.respond({
				model: config.model,
				prompt: config.prompt,
				schema,
				schemaName: Option.getOrUndefined(config.schemaName),
				maxTokens: Option.getOrUndefined(config.maxTokens),
				temperature: Option.getOrUndefined(config.temperature),
				instructions: Option.getOrUndefined(config.instructions),
			});

			// Always on stderr, before any mode returns: token cost is not knowable
			// before the call, so it should never be hidden after it.
			const { cost, inputTokens, outputTokens, reasoningTokens } = result.usage;
			const spent = [
				cost === undefined ? undefined : `$${cost.toFixed(6)}`,
				inputTokens === undefined
					? undefined
					: `${inputTokens} in / ${outputTokens ?? 0} out`,
				reasoningTokens ? `${reasoningTokens} reasoning` : undefined,
			].filter((part) => part !== undefined);
			yield* Console.error(`[${result.model}] ${spent.join("  ")}`);

			if (config.reasoning && result.reasoning !== undefined) {
				yield* Console.error(`\n${result.reasoning}\n`);
			}

			// A truncated answer is worse than no answer when it is meant to be
			// JSON, so say so rather than letting jq fail on a half object.
			if (result.status !== undefined && result.status !== "completed") {
				yield* Console.error(
					`warning: the model stopped with status "${result.status}" — the output may be truncated. Raise --max-tokens.`,
				);
			}

			if (config.json) {
				return yield* emitJson(result);
			}

			yield* Console.log(result.text);
		}),
).pipe(
	Command.withShortDescription("Run a prompt through any model."),
	Command.withDescription(
		`Send one prompt to any model on OpenRouter and print the answer.

Uses the stateless Responses API: there is no conversation history, so
each call stands alone and --prompt carries everything the model sees.

The answer goes to stdout and the cost to stderr, so output is always
safe to pipe. With --schema the model must return JSON matching that
schema, and stdout is the JSON object itself — no prose to strip, no
code fences to unwrap.

Any model on OpenRouter works. Cost varies by orders of magnitude
between them, and every call reports what it actually spent.

Requires an OpenRouter API key: run \`infer keys set\` or set
OPENROUTER_API_KEY. Check the balance with \`infer budget openrouter\`.`,
	),
	Command.withExamples([
		{
			command: `infer openrouter response anthropic/claude-sonnet-5 --prompt "Explain CRDTs in three sentences."`,
			description: "Ask a model a question",
		},
		{
			command: `infer openrouter response openai/gpt-oss-20b --prompt "Paris, France, 2.1 million people" --schema '{"type":"object","properties":{"city":{"type":"string"},"population":{"type":"number"}},"required":["city","population"],"additionalProperties":false}'`,
			description: "Force a JSON answer matching a schema",
		},
		{
			command: `infer openrouter response x-ai/grok-4.5 --prompt "Summarise this" --schema @schema.json | jq .`,
			description: "Load a larger schema from a file",
		},
		{
			command: `infer openrouter response deepseek/deepseek-v4-flash-0731 --prompt "Draft a commit message" --instructions "Answer in imperative mood, one line."`,
			description: "Set a role with --instructions",
		},
	]),
);

export const openrouterCmd = Command.make("openrouter").pipe(
	Command.withShortDescription("Run prompts through any model."),
	Command.withDescription(
		`Run prompts through any of the models OpenRouter fronts.

One key reaches hundreds of models from every major provider, which
makes this the way to reach a model the other commands do not wrap.

Requires an OpenRouter API key: run \`infer keys set\` or set
OPENROUTER_API_KEY. Check what is left with \`infer budget openrouter\`.`,
	),
	Command.withSubcommands([responseCmd]),
);
