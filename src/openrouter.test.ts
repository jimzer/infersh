import { describe, expect, test } from "bun:test";
import {
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
