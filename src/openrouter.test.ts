import { describe, expect, test } from "bun:test";
import {
	filterModels,
	formatContext,
	formatPrice,
	modelsQuery,
	parseEndpoints,
	parseModels,
	parseResponse,
	type ResponseOptions,
	responseBody,
	usageOf,
	validateSchema,
} from "./openrouter.ts";

const base: ResponseOptions = {
	model: "openai/gpt-oss-20b",
	prompt: "hello",
};

const opts = (over: Partial<ResponseOptions> = {}): ResponseOptions => ({
	...base,
	...over,
});

const SCHEMA = {
	type: "object",
	properties: { city: { type: "string" } },
	required: ["city"],
	additionalProperties: false,
};

describe("validateSchema", () => {
	test("accepts an object schema", () => {
		expect(validateSchema(SCHEMA)).toBeNull();
	});

	test("accepts a schema with no explicit type", () => {
		expect(validateSchema({ properties: {} })).toBeNull();
	});

	test("rejects non-objects", () => {
		for (const bad of [null, "text", 42, [1, 2]]) {
			expect(validateSchema(bad)).toContain("must be a JSON object");
		}
	});

	test("rejects a non-object top level, and says how to fix it", () => {
		// Providers reject these when strict is on; catching it here costs nothing.
		const problem = validateSchema({ type: "array", items: {} });
		expect(problem).toContain("object at the top level");
		expect(problem).toContain('{"type":"object"');
	});
});

describe("responseBody", () => {
	test("sends the prompt as input", () => {
		expect(responseBody(base)).toEqual({
			model: "openai/gpt-oss-20b",
			input: "hello",
		});
	});

	test("omits every unset option rather than sending nulls", () => {
		expect(Object.keys(responseBody(base)).sort()).toEqual(["input", "model"]);
	});

	test("wraps a schema in the OpenAI-compatible text.format shape", () => {
		expect(responseBody(opts({ schema: SCHEMA })).text).toEqual({
			format: {
				type: "json_schema",
				name: "output",
				strict: true,
				schema: SCHEMA,
			},
		});
	});

	test("uses the given schema name", () => {
		const body = responseBody(opts({ schema: SCHEMA, schemaName: "city" }));
		expect((body.text as { format: { name: string } }).format.name).toBe(
			"city",
		);
	});

	test("maps maxTokens to max_output_tokens, the Responses API name", () => {
		expect(responseBody(opts({ maxTokens: 500 })).max_output_tokens).toBe(500);
		expect(responseBody(opts({ maxTokens: 500 })).max_tokens).toBeUndefined();
	});

	test("carries instructions and temperature when set", () => {
		const body = responseBody(
			opts({ instructions: "be terse", temperature: 0 }),
		);
		expect(body.instructions).toBe("be terse");
		expect(body.temperature).toBe(0);
	});

	test("keeps a zero temperature, which is a real setting", () => {
		expect(responseBody(opts({ temperature: 0 })).temperature).toBe(0);
	});
});

/** Shaped like a real response: reasoning and message items interleaved. */
const payload = {
	model: "openai/gpt-oss-20b",
	status: "completed",
	output: [
		{
			type: "reasoning",
			content: [{ type: "reasoning_text", text: "thinking about it" }],
		},
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: '{"city":"Paris"}' }],
		},
	],
	usage: {
		input_tokens: 80,
		output_tokens: 103,
		output_tokens_details: { reasoning_tokens: 91 },
		cost: 0.00001579,
	},
};

describe("parseResponse", () => {
	test("reads text, reasoning, model and status", () => {
		const result = parseResponse(payload, "fallback");
		expect(result?.text).toBe('{"city":"Paris"}');
		expect(result?.reasoning).toBe("thinking about it");
		expect(result?.model).toBe("openai/gpt-oss-20b");
		expect(result?.status).toBe("completed");
	});

	test("joins several output_text parts across messages", () => {
		const result = parseResponse(
			{
				output: [
					{ type: "message", content: [{ type: "output_text", text: "a" }] },
					{
						type: "message",
						content: [
							{ type: "output_text", text: "b" },
							{ type: "output_text", text: "c" },
						],
					},
				],
			},
			"m",
		);
		expect(result?.text).toBe("abc");
	});

	test("ignores reasoning when reading the answer", () => {
		// Reasoning text must never leak into stdout, least of all under --schema.
		const result = parseResponse(payload, "m");
		expect(result?.text).not.toContain("thinking");
	});

	test("omits reasoning entirely when the model produced none", () => {
		const result = parseResponse(
			{
				output: [
					{ type: "message", content: [{ type: "output_text", text: "hi" }] },
				],
			},
			"m",
		);
		expect(result?.reasoning).toBeUndefined();
	});

	test("survives malformed items instead of throwing", () => {
		const result = parseResponse(
			{
				output: [
					null,
					{ type: "message" },
					{ type: "message", content: "not an array" },
					{ type: "message", content: [{ type: "output_text" }] },
					{ type: "message", content: [{ type: "output_text", text: "ok" }] },
				],
			},
			"m",
		);
		expect(result?.text).toBe("ok");
	});

	test("falls back to the requested model when the response omits one", () => {
		expect(parseResponse({ output: [] }, "requested")?.model).toBe("requested");
	});

	test("returns null when there is no output array at all", () => {
		expect(parseResponse({}, "m")).toBeNull();
		expect(parseResponse(null, "m")).toBeNull();
		expect(parseResponse({ output: "nope" }, "m")).toBeNull();
	});

	test("keeps an incomplete status, which signals truncation", () => {
		const result = parseResponse({ ...payload, status: "incomplete" }, "m");
		expect(result?.status).toBe("incomplete");
	});
});

describe("usageOf", () => {
	test("reads tokens, reasoning tokens and cost", () => {
		expect(usageOf(payload)).toEqual({
			inputTokens: 80,
			outputTokens: 103,
			reasoningTokens: 91,
			cost: 0.00001579,
		});
	});

	test("copes with usage that has no details block", () => {
		expect(usageOf({ usage: { input_tokens: 5 } })).toEqual({ inputTokens: 5 });
	});

	test("is empty when there is no usage", () => {
		expect(usageOf({})).toEqual({});
		expect(usageOf(null)).toEqual({});
	});
});

const MODELS_PAYLOAD = {
	data: [
		{
			id: "anthropic/claude-sonnet-5",
			name: "Claude Sonnet 5",
			description: "A capable model",
			context_length: 1000000,
			pricing: { prompt: "0.000002", completion: "0.00001" },
			architecture: { modality: "text+image->text" },
			supported_parameters: ["tools", "structured_outputs"],
			reasoning: { default_enabled: false },
		},
		{
			id: "openai/gpt-oss-20b",
			name: "GPT OSS 20B",
			context_length: 131072,
			pricing: { prompt: "0.00000005", completion: "0.0000002" },
			supported_parameters: ["structured_outputs"],
		},
	],
};

describe("modelsQuery", () => {
	test("sends only the filters the API honours", () => {
		expect(modelsQuery({ category: "programming", supports: "tools" })).toBe(
			"category=programming&supported_parameters=tools",
		);
	});

	test("never sends author, which the API silently ignores", () => {
		// ?author=anthropic returned all 364 models live, so it must be local.
		expect(modelsQuery({ author: "anthropic" })).toBe("");
	});

	test("is empty when nothing is filtered server-side", () => {
		expect(modelsQuery({ q: "claude", maxPrice: 1, limit: 5 })).toBe("");
	});
});

describe("parseModels", () => {
	test("converts per-token prices to per-million", () => {
		const [first] = parseModels(MODELS_PAYLOAD);
		expect(first?.inputPrice).toBeCloseTo(2, 6);
		expect(first?.outputPrice).toBeCloseTo(10, 6);
	});

	test("reads context, modality and supported parameters", () => {
		const [first] = parseModels(MODELS_PAYLOAD);
		expect(first?.contextLength).toBe(1000000);
		expect(first?.modality).toBe("text+image->text");
		expect(first?.supportedParameters).toEqual(["tools", "structured_outputs"]);
	});

	test("copes with models missing optional blocks", () => {
		const models = parseModels({ data: [{ id: "bare/model" }] });
		expect(models[0]?.id).toBe("bare/model");
		expect(models[0]?.supportedParameters).toEqual([]);
	});

	test("skips entries with no id rather than emitting blanks", () => {
		expect(
			parseModels({ data: [{ name: "no id" }, { id: "a/b" }] }),
		).toHaveLength(1);
	});

	test("returns empty for an unexpected payload", () => {
		expect(parseModels({})).toEqual([]);
		expect(parseModels(null)).toEqual([]);
	});
});

describe("filterModels", () => {
	const models = parseModels(MODELS_PAYLOAD);

	test("filters by author on the slug prefix", () => {
		expect(
			filterModels(models, { author: "anthropic" }).map((m) => m.id),
		).toEqual(["anthropic/claude-sonnet-5"]);
	});

	test("author matching is case-insensitive and anchored", () => {
		expect(filterModels(models, { author: "ANTHROPIC" })).toHaveLength(1);
		// "sonnet" appears in the id but not as the author, so it must not match.
		expect(filterModels(models, { author: "sonnet" })).toHaveLength(0);
	});

	test("free text searches id, name and description", () => {
		expect(filterModels(models, { q: "capable" })).toHaveLength(1);
		expect(filterModels(models, { q: "gpt" })).toHaveLength(1);
	});

	test("an empty query matches everything", () => {
		expect(filterModels(models, { q: "" })).toHaveLength(2);
		expect(filterModels(models, {})).toHaveLength(2);
	});

	test("max price is a ceiling on input price per million", () => {
		expect(filterModels(models, { maxPrice: 1 }).map((m) => m.id)).toEqual([
			"openai/gpt-oss-20b",
		]);
	});

	test("min context is a floor", () => {
		expect(filterModels(models, { minContext: 500000 })).toHaveLength(1);
	});

	test("drops models with no price when filtering on price", () => {
		// An unknown price cannot be asserted to be under the ceiling.
		const bare = parseModels({ data: [{ id: "a/b" }] });
		expect(filterModels(bare, { maxPrice: 10 })).toHaveLength(0);
	});

	test("limit truncates last, after every other filter", () => {
		expect(filterModels(models, { limit: 1 })).toHaveLength(1);
		expect(filterModels(models, { author: "openai", limit: 5 })).toHaveLength(
			1,
		);
	});
});

describe("parseEndpoints", () => {
	const payload = {
		data: {
			id: "meta-llama/llama-3.3-70b-instruct",
			endpoints: [
				{
					provider_name: "DeepInfra",
					context_length: 131072,
					pricing: { prompt: "0.0000001", completion: "0.00000032" },
					quantization: "fp8",
					uptime_last_30m: 94.62,
				},
				{
					provider_name: "Novita",
					context_length: 6000,
					pricing: { prompt: "0.000000135" },
					quantization: "bf16",
				},
			],
		},
	};

	test("reads provider, context, price and quantization", () => {
		const [first] = parseEndpoints(payload);
		expect(first?.provider).toBe("DeepInfra");
		expect(first?.contextLength).toBe(131072);
		expect(first?.inputPrice).toBeCloseTo(0.1, 6);
		expect(first?.quantization).toBe("fp8");
		expect(first?.uptime).toBeCloseTo(94.62, 2);
	});

	test("keeps a provider serving a much smaller context, which is the point", () => {
		// Novita serves llama-3.3-70b at 6k, not 131k — the trap this reveals.
		const [, second] = parseEndpoints(payload);
		expect(second?.contextLength).toBe(6000);
		expect(second?.uptime).toBeUndefined();
	});

	test("returns empty when the shape is not an endpoints payload", () => {
		expect(parseEndpoints({ data: [] })).toEqual([]);
		expect(parseEndpoints({})).toEqual([]);
		expect(parseEndpoints(null)).toEqual([]);
	});
});

describe("formatContext", () => {
	test("abbreviates thousands and millions", () => {
		expect(formatContext(131072)).toBe("131K");
		expect(formatContext(1000000)).toBe("1M");
		expect(formatContext(2000000)).toBe("2M");
		expect(formatContext(6000)).toBe("6K");
		expect(formatContext(512)).toBe("512");
	});

	test("shows a dash rather than pretending zero", () => {
		expect(formatContext(undefined)).toBe("—");
	});
});

describe("formatPrice", () => {
	test("trims the float noise the API returns", () => {
		// The live API sends 0.09999999999999999 for ten cents.
		expect(formatPrice(0.09999999999999999)).toBe("$0.1");
		expect(formatPrice(2)).toBe("$2");
	});

	test("shows a dash for an unknown price", () => {
		expect(formatPrice(undefined)).toBe("—");
	});
});
