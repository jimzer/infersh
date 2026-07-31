/**
 * OpenRouter — one prompt, any model, over the Responses API.
 *
 * Spoken to over plain HTTP rather than through `@openrouter/sdk`: the SDK is
 * generated and its request schemas do not use `.passthrough()`, so any field
 * it has not modelled is stripped before the request leaves the process. That
 * failure is invisible — the call still returns 200 and the model still
 * answers, just without whatever you asked for. See `docs/adrs/0015`.
 *
 * The endpoint is stateless by design: `store` and `previous_response_id` are
 * rejected with a 400, so there is no conversation to keep and each call is
 * one self-contained prompt.
 */

import { Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { MissingKeyError, Secrets } from "./secrets.ts";

const RESPONSES_URL = "https://openrouter.ai/api/v1/responses";

export class OpenRouterError extends Data.TaggedError("OpenRouterError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

export interface ResponseOptions {
	readonly model: string;
	readonly prompt: string;
	/** A JSON Schema; when present the model must answer with matching JSON. */
	readonly schema?: unknown;
	/** Names the schema for the provider. Cosmetic, but required by the API. */
	readonly schemaName?: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly instructions?: string;
}

export interface Usage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly reasoningTokens?: number;
	/** What the call cost, in USD, as reported by OpenRouter. */
	readonly cost?: number;
}

export interface ResponseResult {
	readonly text: string;
	/** Present only when the model produced a reasoning block. */
	readonly reasoning?: string;
	readonly usage: Usage;
	readonly model: string;
	readonly status?: string;
}

// --- Request --------------------------------------------------------------

/**
 * Checks a `--schema` payload before spending anything.
 *
 * Providers enforce `strict: true` by rejecting schemas they cannot compile,
 * and the common causes are cheap to catch here: a non-object, or a top level
 * that is not `"type": "object"`.
 */
export const validateSchema = (schema: unknown): string | null => {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return "--schema must be a JSON object describing a JSON Schema.";
	}
	const type = (schema as { type?: unknown }).type;
	if (type !== undefined && type !== "object") {
		return `--schema must describe an object at the top level, got "${String(type)}". Wrap it: {"type":"object","properties":{...}}`;
	}
	return null;
};

/**
 * The JSON body for `/responses`.
 *
 * Structured output uses the OpenAI-compatible `text.format.json_schema`
 * shape, which is not in OpenRouter's own documentation but is what the
 * endpoint accepts — verified live against `openai/gpt-oss-20b`.
 */
export const responseBody = (
	options: ResponseOptions,
): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		model: options.model,
		input: options.prompt,
	};
	if (options.instructions !== undefined) {
		body.instructions = options.instructions;
	}
	if (options.maxTokens !== undefined) {
		body.max_output_tokens = options.maxTokens;
	}
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (options.schema !== undefined) {
		body.text = {
			format: {
				type: "json_schema",
				name: options.schemaName ?? "output",
				strict: true,
				schema: options.schema,
			},
		};
	}
	return body;
};

// --- Response -------------------------------------------------------------

const asString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Joins every `output_text` across the message items.
 *
 * The output array interleaves `reasoning` and `message` items, and a message
 * may carry several content parts, so the answer has to be assembled rather
 * than read from a fixed position.
 */
const collectText = (
	output: ReadonlyArray<unknown>,
	itemType: string,
	contentType: string,
): string => {
	const parts: Array<string> = [];
	for (const item of output) {
		if (typeof item !== "object" || item === null) continue;
		if ((item as { type?: unknown }).type !== itemType) continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			if ((part as { type?: unknown }).type !== contentType) continue;
			const text = asString((part as { text?: unknown }).text);
			if (text !== undefined) parts.push(text);
		}
	}
	return parts.join("");
};

export const usageOf = (payload: unknown): Usage => {
	if (typeof payload !== "object" || payload === null) return {};
	const usage = (payload as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return {};
	const record = usage as Record<string, unknown>;
	const details = record.output_tokens_details;
	const reasoningTokens =
		typeof details === "object" && details !== null
			? asNumber((details as { reasoning_tokens?: unknown }).reasoning_tokens)
			: undefined;
	const inputTokens = asNumber(record.input_tokens);
	const outputTokens = asNumber(record.output_tokens);
	const cost = asNumber(record.cost);
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		...(cost === undefined ? {} : { cost }),
	};
};

export const parseResponse = (
	payload: unknown,
	fallbackModel: string,
): ResponseResult | null => {
	if (typeof payload !== "object" || payload === null) return null;
	const output = (payload as { output?: unknown }).output;
	if (!Array.isArray(output)) return null;

	const reasoning = collectText(output, "reasoning", "reasoning_text");
	return {
		text: collectText(output, "message", "output_text"),
		...(reasoning === "" ? {} : { reasoning }),
		usage: usageOf(payload),
		model: asString((payload as { model?: unknown }).model) ?? fallbackModel,
		...(asString((payload as { status?: unknown }).status) === undefined
			? {}
			: { status: asString((payload as { status?: unknown }).status) }),
	};
};

// --- Service --------------------------------------------------------------

export interface OpenRouterShape {
	readonly respond: (
		options: ResponseOptions,
	) => Effect.Effect<ResponseResult, OpenRouterError>;
}

export class OpenRouter extends Context.Service<OpenRouter, OpenRouterShape>()(
	"OpenRouter",
) {}

const make = (options: {
	readonly http: HttpClient.HttpClient;
	readonly credentials: Option.Option<string>;
}): OpenRouterShape => {
	const { http, credentials } = options;

	const requireCredentials = Option.isSome(credentials)
		? Effect.succeed(credentials.value)
		: Effect.fail(
				new OpenRouterError({
					reason: new MissingKeyError({ provider: "openrouter" }).message,
				}),
			);

	return {
		respond: (request) =>
			Effect.gen(function* () {
				if (request.schema !== undefined) {
					const problem = validateSchema(request.schema);
					if (problem !== null) {
						return yield* Effect.fail(new OpenRouterError({ reason: problem }));
					}
				}

				const key = yield* requireCredentials;
				const response = yield* http
					.execute(
						HttpClientRequest.post(RESPONSES_URL, {
							headers: {
								Authorization: `Bearer ${key}`,
								"Content-Type": "application/json",
								// Identifies the caller on OpenRouter's dashboards.
								"HTTP-Referer": "https://github.com/jimzer/infersh",
								"X-Title": "infer",
							},
						}).pipe(HttpClientRequest.bodyJsonUnsafe(responseBody(request))),
					)
					.pipe(
						Effect.mapError(
							(cause) =>
								new OpenRouterError({ reason: `Request failed: ${cause}` }),
						),
					);

				const text = yield* response.text.pipe(
					Effect.mapError(
						(cause) =>
							new OpenRouterError({
								reason: `Could not read the response: ${cause}`,
							}),
					),
				);

				if (response.status >= 400) {
					return yield* Effect.fail(
						new OpenRouterError({
							reason: `OpenRouter returned ${response.status}: ${text.slice(0, 500)}`,
						}),
					);
				}

				let payload: unknown;
				try {
					payload = JSON.parse(text);
				} catch (cause) {
					return yield* Effect.fail(
						new OpenRouterError({
							reason: `OpenRouter returned a non-JSON body: ${cause}`,
						}),
					);
				}

				const result = parseResponse(payload, request.model);
				if (result === null) {
					return yield* Effect.fail(
						new OpenRouterError({
							reason: `No output in the response: ${text.slice(0, 300)}`,
						}),
					);
				}
				return result;
			}),
	};
};

export const layer: Layer.Layer<
	OpenRouter,
	never,
	Secrets | HttpClient.HttpClient
> = Layer.effect(OpenRouter)(
	Effect.gen(function* () {
		const secrets = yield* Secrets;
		const http = yield* HttpClient.HttpClient;
		const resolved = yield* secrets
			.get("openrouter")
			.pipe(Effect.orElseSucceed(Option.none));
		return make({
			http,
			credentials: Option.map(resolved, (r) => Redacted.value(r.key)),
		});
	}),
);
