/**
 * `infer openrouter` — run a prompt through any model on OpenRouter.
 */

import { readFileSync } from "node:fs";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
	formatContext,
	formatPrice,
	OpenRouter,
	OpenRouterError,
} from "../openrouter.ts";
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

// --- models ---------------------------------------------------------------

const modelsCmd = Command.make(
	"models",
	{
		query: Flag.string("q").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				"Free-text search across model id, name and description.",
			),
		),
		author: Flag.string("author").pipe(
			Flag.withMetavar("name"),
			Flag.optional,
			Flag.withDescription(
				"Only models from this author, matching the part before the slash: anthropic, openai, x-ai, google.",
			),
		),
		category: Flag.string("category").pipe(
			Flag.withMetavar("name"),
			Flag.optional,
			Flag.withDescription(
				"Restrict to one of OpenRouter's categories, e.g. programming.",
			),
		),
		supports: Flag.string("supports").pipe(
			Flag.withMetavar("param"),
			Flag.optional,
			Flag.withDescription(
				"Only models supporting a parameter, e.g. structured_outputs, tools, reasoning. Use this to find models that work with `response --schema`.",
			),
		),
		maxPrice: Flag.float("max-price").pipe(
			Flag.withMetavar("usd"),
			Flag.optional,
			Flag.withDescription(
				"Only models at or below this input price, in USD per million tokens.",
			),
		),
		minContext: Flag.integer("min-context").pipe(
			Flag.withMetavar("tokens"),
			Flag.optional,
			Flag.withDescription(
				"Only models whose context window is at least this many tokens.",
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Print at most this many models. Omit for all of them; nothing is truncated silently.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const openrouter = yield* OpenRouter;
			const models = yield* openrouter.models({
				q: Option.getOrUndefined(config.query),
				author: Option.getOrUndefined(config.author),
				category: Option.getOrUndefined(config.category),
				supports: Option.getOrUndefined(config.supports),
				maxPrice: Option.getOrUndefined(config.maxPrice),
				minContext: Option.getOrUndefined(config.minContext),
				limit: Option.getOrUndefined(config.limit),
			});

			if (config.json) return yield* emitJson({ models });

			if (models.length === 0) {
				yield* Console.error("No models matched.");
				return;
			}

			for (const model of models) {
				const facts = [
					`ctx=${formatContext(model.contextLength)}`,
					`in=${formatPrice(model.inputPrice)}`,
					`out=${formatPrice(model.outputPrice)}`,
				].join("  ");
				yield* Console.log(`${model.id.padEnd(44)} ${facts}`);
			}
			yield* Console.error(`\n${models.length} models`);
		}),
).pipe(
	Command.withShortDescription("Search the model catalogue."),
	Command.withDescription(
		`List and filter the models OpenRouter fronts.

With no flags, lists every model. Filters narrow it. Prints the slug
first on each line, so \`| awk '{print $1}'\` feeds straight into
\`infer openrouter response\`.

Prices are USD per million tokens, input and output. Context is the
model's headline window — the provider actually serving it may offer
less, which \`infer openrouter endpoints\` reveals.

Needs no API key.`,
	),
	Command.withExamples([
		{ command: "infer openrouter models", description: "List every model" },
		{
			command: "infer openrouter models --q claude --author anthropic",
			description: "Search within one author",
		},
		{
			command:
				"infer openrouter models --supports structured_outputs --max-price 1",
			description: "Find cheap models that work with --schema",
		},
		{
			command:
				"infer openrouter models --min-context 1000000 --json | jq -r '.models[].id'",
			description: "Long-context models, as a plain list",
		},
	]),
);

// --- endpoints ------------------------------------------------------------

const endpointsCmd = Command.make(
	"endpoints",
	{
		model: Argument.string("model").pipe(
			Argument.withDescription(
				"The model to inspect, as author/name. Find one with `infer openrouter models`.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const openrouter = yield* OpenRouter;
			const endpoints = yield* openrouter.endpoints(config.model);

			if (config.json) {
				return yield* emitJson({ model: config.model, endpoints });
			}

			for (const endpoint of endpoints) {
				const facts = [
					`ctx=${formatContext(endpoint.contextLength)}`,
					`in=${formatPrice(endpoint.inputPrice)}`,
					`out=${formatPrice(endpoint.outputPrice)}`,
					`quant=${endpoint.quantization ?? "—"}`,
					`up=${endpoint.uptime === undefined ? "—" : `${Math.floor(endpoint.uptime)}%`}`,
				].join("  ");
				yield* Console.log(`${endpoint.provider.padEnd(20)} ${facts}`);
			}
			yield* Console.error(`\n${endpoints.length} providers serve this model`);
		}),
).pipe(
	Command.withShortDescription("Show which providers serve a model."),
	Command.withDescription(
		`List every upstream provider that serves one model.

OpenRouter is a router: a single model slug may be served by a dozen
providers, and they are not interchangeable. For the same model they
can differ in price by 10x, in context window by 20x, and in
quantization — which changes output quality for identical weights.

Worth checking before a long-context or high-volume job: a provider
advertising the model may serve it with a far smaller window than the
catalogue's headline figure.

Uptime is the percentage over the last 30 minutes. Latency and
throughput are not published by this API, so they are not shown.

Needs no API key.`,
	),
	Command.withExamples([
		{
			command: "infer openrouter endpoints meta-llama/llama-3.3-70b-instruct",
			description: "See every provider, price and context window",
		},
		{
			command:
				"infer openrouter endpoints anthropic/claude-sonnet-5 --json | jq '.endpoints | min_by(.inputPrice)'",
			description: "Find the cheapest provider for a model",
		},
	]),
);

export const openrouterCmd = Command.make("openrouter").pipe(
	Command.withShortDescription("Run prompts through any model."),
	Command.withDescription(
		`Run prompts through any of the models OpenRouter fronts.

One key reaches hundreds of models from every major provider, which
makes this the way to reach a model the other commands do not wrap.

A typical session: find a model with \`models\`, check who serves it and
at what price with \`endpoints\`, then call it with \`response\`. The
first two need no API key.

Requires an OpenRouter API key: run \`infer keys set\` or set
OPENROUTER_API_KEY. Check what is left with \`infer budget openrouter\`.`,
	),
	Command.withSubcommands([responseCmd, modelsCmd, endpointsCmd]),
);
