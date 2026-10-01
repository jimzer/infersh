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

import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { decodeEach, JsonObject, JsonText, lenient } from "./json.ts";
import { lazyKey, MissingKeyError, type Secrets } from "./secrets.ts";

const RESPONSES_URL = "https://openrouter.ai/api/v1/responses";
const MODELS_URL = "https://openrouter.ai/api/v1/models";

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
export const validateSchema = (schema: unknown): string | null =>
	Option.match(Schema.decodeUnknownOption(JsonObject)(schema), {
		onNone: () => "--schema must be a JSON object describing a JSON Schema.",
		onSome: ({ type }) =>
			type !== undefined && type !== "object"
				? `--schema must describe an object at the top level, got "${String(type)}". Wrap it: {"type":"object","properties":{...}}`
				: null,
	});

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

/** One item of the Responses API `output` array: a message or reasoning. */
const OutputItem = Schema.Struct({
	type: Schema.String,
	content: lenient(Schema.Array(Schema.Unknown)),
});

const ContentPart = Schema.Struct({
	type: Schema.String,
	text: lenient(Schema.String),
});

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
): string =>
	decodeEach(OutputItem)(output)
		.filter((item) => item.type === itemType)
		.flatMap((item) => decodeEach(ContentPart)(item.content ?? []))
		.flatMap((part) =>
			part.type === contentType && part.text !== undefined ? [part.text] : [],
		)
		.join("");

const WithUsage = Schema.Struct({
	usage: Schema.Struct({
		input_tokens: lenient(Schema.Finite),
		output_tokens: lenient(Schema.Finite),
		cost: lenient(Schema.Finite),
		output_tokens_details: lenient(
			Schema.Struct({ reasoning_tokens: lenient(Schema.Finite) }),
		),
	}),
});

export const usageOf = (payload: unknown): Usage =>
	Option.match(Schema.decodeUnknownOption(WithUsage)(payload), {
		onNone: () => ({}),
		onSome: ({ usage }) => ({
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
			cost: usage.cost,
		}),
	});

const ResponseBody = Schema.Struct({
	output: Schema.Array(Schema.Unknown),
	model: lenient(Schema.String),
	status: lenient(Schema.String),
});

export const parseResponse = (
	payload: unknown,
	fallbackModel: string,
): ResponseResult | null =>
	Option.match(Schema.decodeUnknownOption(ResponseBody)(payload), {
		onNone: () => null,
		onSome: (body) => {
			const reasoning = collectText(body.output, "reasoning", "reasoning_text");
			return {
				text: collectText(body.output, "message", "output_text"),
				...(reasoning === "" ? {} : { reasoning }),
				usage: usageOf(payload),
				model: body.model ?? fallbackModel,
				...(body.status === undefined ? {} : { status: body.status }),
			};
		},
	});

// --- Model catalogue ------------------------------------------------------

export interface Model {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly contextLength?: number;
	/** USD per million input tokens. */
	readonly inputPrice?: number;
	/** USD per million output tokens. */
	readonly outputPrice?: number;
	readonly modality?: string;
	readonly supportedParameters: ReadonlyArray<string>;
	readonly reasoning: boolean;
}

/** One upstream deployment of a model, as OpenRouter would route to it. */
export interface Endpoint {
	readonly provider: string;
	readonly contextLength?: number;
	readonly inputPrice?: number;
	readonly outputPrice?: number;
	readonly quantization?: string;
	/** Percentage over the last 30 minutes. */
	readonly uptime?: number;
	readonly maxCompletionTokens?: number;
}

export interface ModelFilters {
	readonly q?: string;
	readonly author?: string;
	readonly category?: string;
	readonly supports?: string;
	/** Ceiling on USD per million input tokens. */
	readonly maxPrice?: number;
	readonly minContext?: number;
	readonly limit?: number;
}

/**
 * Query string for `/models`.
 *
 * Only `category` and `supported_parameters` are honoured by the API. An
 * `author` parameter is silently ignored — it returns the full list rather
 * than erroring — so that filter is applied locally instead. Verified against
 * the live endpoint: `?author=anthropic` returned all 364 models.
 */
export const modelsQuery = (filters: ModelFilters): string => {
	const query = new URLSearchParams();
	if (filters.category) query.set("category", filters.category);
	if (filters.supports) query.set("supported_parameters", filters.supports);
	return query.toString();
};

/** Prices arrive as strings of dollars per token, sometimes as numbers. */
const Price = lenient(Schema.Union([Schema.Finite, Schema.FiniteFromString]));

const Pricing = lenient(Schema.Struct({ prompt: Price, completion: Price }));

/** Dollars per token → dollars per million tokens, which is how humans compare. */
const perMillion = (perToken: number | undefined): number | undefined =>
	perToken === undefined ? undefined : perToken * 1_000_000;

const ModelEntry = Schema.Struct({
	id: Schema.String,
	name: lenient(Schema.String),
	description: lenient(Schema.String),
	context_length: lenient(Schema.Finite),
	pricing: Pricing,
	architecture: lenient(Schema.Struct({ modality: lenient(Schema.String) })),
	supported_parameters: lenient(Schema.Array(Schema.Unknown)),
	// Present, as an object, only on models that can reason.
	reasoning: lenient(Schema.Record(Schema.String, Schema.Unknown)),
});

const ModelsBody = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

export const parseModels = (payload: unknown): ReadonlyArray<Model> =>
	Option.match(Schema.decodeUnknownOption(ModelsBody)(payload), {
		onNone: () => [],
		onSome: ({ data }) =>
			decodeEach(ModelEntry)(data).map((entry) => ({
				id: entry.id,
				name: entry.name,
				description: entry.description,
				contextLength: entry.context_length,
				inputPrice: perMillion(entry.pricing?.prompt),
				outputPrice: perMillion(entry.pricing?.completion),
				modality: entry.architecture?.modality,
				supportedParameters: decodeEach(Schema.String)(
					entry.supported_parameters ?? [],
				),
				reasoning: entry.reasoning !== undefined,
			})),
	});

/** Applies the filters the API does not, in the order that rejects fastest. */
export const filterModels = (
	models: ReadonlyArray<Model>,
	filters: ModelFilters,
): ReadonlyArray<Model> => {
	const needle = filters.q?.toLowerCase();
	const matched = models.filter((model) => {
		if (filters.author !== undefined) {
			if (
				!model.id.toLowerCase().startsWith(`${filters.author.toLowerCase()}/`)
			) {
				return false;
			}
		}
		if (filters.minContext !== undefined) {
			if (model.contextLength === undefined) return false;
			if (model.contextLength < filters.minContext) return false;
		}
		if (filters.maxPrice !== undefined) {
			if (model.inputPrice === undefined) return false;
			if (model.inputPrice > filters.maxPrice) return false;
		}
		if (needle !== undefined && needle !== "") {
			const haystack =
				`${model.id} ${model.name ?? ""} ${model.description ?? ""}`.toLowerCase();
			if (!haystack.includes(needle)) return false;
		}
		return true;
	});
	// Truncating is the caller's explicit request, so it happens last.
	return filters.limit === undefined
		? matched
		: matched.slice(0, filters.limit);
};

const EndpointEntry = Schema.Struct({
	provider_name: Schema.String,
	context_length: lenient(Schema.Finite),
	pricing: Pricing,
	quantization: lenient(Schema.String),
	uptime_last_30m: lenient(Schema.Finite),
	max_completion_tokens: lenient(Schema.Finite),
});

const EndpointsBody = Schema.Struct({
	data: Schema.Struct({ endpoints: Schema.Array(Schema.Unknown) }),
});

export const parseEndpoints = (payload: unknown): ReadonlyArray<Endpoint> =>
	Option.match(Schema.decodeUnknownOption(EndpointsBody)(payload), {
		onNone: () => [],
		onSome: ({ data }) =>
			decodeEach(EndpointEntry)(data.endpoints).map((entry) => ({
				provider: entry.provider_name,
				contextLength: entry.context_length,
				inputPrice: perMillion(entry.pricing?.prompt),
				outputPrice: perMillion(entry.pricing?.completion),
				quantization: entry.quantization,
				uptime: entry.uptime_last_30m,
				maxCompletionTokens: entry.max_completion_tokens,
			})),
	});

/** `131072` → `131K`, because exact token counts are noise in a listing. */
export const formatContext = (tokens: number | undefined): string => {
	if (tokens === undefined) return "—";
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(tokens);
};

/** Trims float noise: the API returns 0.09999999999999999 for ten cents. */
export const formatPrice = (perMillionTokens: number | undefined): string =>
	perMillionTokens === undefined
		? "—"
		: `$${Number(perMillionTokens.toFixed(4))}`;

// --- Service --------------------------------------------------------------

export interface OpenRouterShape {
	readonly respond: (
		options: ResponseOptions,
	) => Effect.Effect<ResponseResult, OpenRouterError>;
	/** The model catalogue. Needs no API key. */
	readonly models: (
		filters: ModelFilters,
	) => Effect.Effect<ReadonlyArray<Model>, OpenRouterError>;
	/** Every upstream deployment of one model. Needs no API key. */
	readonly endpoints: (
		model: string,
	) => Effect.Effect<ReadonlyArray<Endpoint>, OpenRouterError>;
}

export class OpenRouter extends Context.Service<OpenRouter, OpenRouterShape>()(
	"OpenRouter",
) {}

const make = (options: {
	readonly http: HttpClient.HttpClient;
	/** Looked up on first use; see `lazyKey`. */
	readonly credentials: Effect.Effect<Option.Option<string>>;
}): OpenRouterShape => {
	const { http, credentials } = options;

	const requireCredentials = Effect.flatMap(
		credentials,
		Option.match({
			onNone: () =>
				Effect.fail(
					new OpenRouterError({
						reason: new MissingKeyError({ provider: "openrouter" }).message,
					}),
				),
			onSome: Effect.succeed,
		}),
	);

	/** GETs a public catalogue URL; a key is sent only if one happens to exist. */
	const getJson = (url: string): Effect.Effect<unknown, OpenRouterError> =>
		Effect.gen(function* () {
			const headers: Record<string, string> = {
				"HTTP-Referer": "https://github.com/jimzer/infersh",
				"X-Title": "infer",
			};
			const key = yield* credentials;
			if (Option.isSome(key)) headers.Authorization = `Bearer ${key.value}`;
			const response = yield* http
				.get(url, { headers })
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
						reason: `OpenRouter returned ${response.status}: ${text.slice(0, 300)}`,
					}),
				);
			}
			return yield* Schema.decodeUnknownEffect(JsonText)(text).pipe(
				Effect.mapError(
					(cause) =>
						new OpenRouterError({
							reason: `OpenRouter returned a non-JSON body: ${cause.message}`,
						}),
				),
			);
		});

	return {
		models: (filters) =>
			Effect.gen(function* () {
				const query = modelsQuery(filters);
				const payload = yield* getJson(
					query === "" ? MODELS_URL : `${MODELS_URL}?${query}`,
				);
				return filterModels(parseModels(payload), filters);
			}),

		endpoints: (model) =>
			Effect.gen(function* () {
				// The route is /models/{author}/{slug}/endpoints, so the slug must
				// carry its author prefix; without one the URL silently 404s.
				if (!model.includes("/")) {
					return yield* Effect.fail(
						new OpenRouterError({
							reason: `"${model}" is not a full model slug. Use author/name, e.g. anthropic/claude-sonnet-5 — find one with \`infer openrouter models\`.`,
						}),
					);
				}
				const payload = yield* getJson(`${MODELS_URL}/${model}/endpoints`);
				const endpoints = parseEndpoints(payload);
				if (endpoints.length === 0) {
					return yield* Effect.fail(
						new OpenRouterError({
							reason: `No endpoints found for ${model}. Check the slug with \`infer openrouter models --q ${model.split("/").pop()}\`.`,
						}),
					);
				}
				return endpoints;
			}),

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

				const payload = yield* Schema.decodeUnknownEffect(JsonText)(text).pipe(
					Effect.mapError(
						(cause) =>
							new OpenRouterError({
								reason: `OpenRouter returned a non-JSON body: ${cause.message}`,
							}),
					),
				);

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
		const http = yield* HttpClient.HttpClient;
		const credentials = yield* lazyKey("openrouter");
		return make({
			http,
			credentials,
		});
	}),
);
