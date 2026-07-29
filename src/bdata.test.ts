import { describe, expect, test } from "bun:test";
import {
	buildSerpUrl,
	mergeOptions,
	parseBody,
	parseInput,
	renderResult,
	requestBody,
} from "./bdata.ts";

const ALLOWED = ["country", "dataFormat", "format", "numResults"] as const;

interface Flags {
	country?: string;
	format?: string;
	start?: number;
}

describe("parseInput", () => {
	test("accepts a JSON object of known options", () => {
		expect(
			parseInput('{"dataFormat":"markdown","country":"gb"}', ALLOWED),
		).toEqual({ options: { dataFormat: "markdown", country: "gb" } });
	});

	test("accepts an empty object", () => {
		expect(parseInput("{}", ALLOWED)).toEqual({ options: {} });
	});

	test("rejects invalid JSON with the parser's reason", () => {
		const result = parseInput("not json", ALLOWED);
		expect("error" in result && result.error).toContain("not valid JSON");
	});

	test("rejects a non-object payload", () => {
		for (const raw of ["[]", '"text"', "42", "null"]) {
			const result = parseInput(raw, ALLOWED);
			expect("error" in result && result.error).toContain("JSON object");
		}
	});

	test("rejects unknown keys instead of silently dropping them", () => {
		// The SDK's schema would ignore data_format; catching it here is the
		// whole reason --input validates rather than passing straight through.
		const result = parseInput('{"data_format":"markdown"}', ALLOWED);
		expect("error" in result && result.error).toContain("data_format");
		expect("error" in result && result.error).toContain("Accepted:");
	});

	test("lists every unknown key", () => {
		const result = parseInput('{"a":1,"b":2}', ALLOWED);
		expect("error" in result && result.error).toContain("a, b");
		expect("error" in result && result.error).toContain("options:");
	});
});

describe("mergeOptions", () => {
	const flags = (over: Flags = {}): Flags => ({
		country: undefined,
		format: undefined,
		start: undefined,
		...over,
	});

	test("keeps input keys the flags do not set", () => {
		expect(mergeOptions({ country: "gb" }, flags())).toEqual({ country: "gb" });
	});

	test("an explicit flag wins over the same key in --input", () => {
		expect(mergeOptions({ country: "gb" }, flags({ country: "us" }))).toEqual({
			country: "us",
		});
	});

	test("drops undefined flags so they never mask an input value", () => {
		const merged = mergeOptions({ format: "json" }, flags());
		expect(merged).toEqual({ format: "json" });
	});

	test("keeps falsy but meaningful flag values", () => {
		expect(mergeOptions({ start: 5 }, flags({ start: 0 }))).toEqual({
			start: 0,
		});
	});
});

describe("renderResult", () => {
	test("prints a raw string unchanged, so HTML stays HTML", () => {
		expect(renderResult("<html>hi</html>")).toBe("<html>hi</html>");
	});

	test("pretty-prints an object so it can be piped to jq", () => {
		expect(renderResult({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	test("handles an array of batch results", () => {
		expect(renderResult([{ a: 1 }])).toContain('"a": 1');
	});
});

describe("buildSerpUrl", () => {
	test("asks Google for parsed JSON via brd_json", () => {
		const url = buildSerpUrl("google", "pizza restaurants", {});
		expect(url).toContain(
			"https://www.google.com/search?q=pizza%20restaurants",
		);
		expect(url).toContain("brd_json=1");
		expect(url).toContain("hl=en");
	});

	test("adds Google paging and geo only when asked", () => {
		const url = buildSerpUrl("google", "pizza", { start: 20, country: "gb" });
		expect(url).toContain("start=20");
		expect(url).toContain("gl=gb");
		expect(buildSerpUrl("google", "pizza", {})).not.toContain("start=");
	});

	test("builds a Bing URL with the market only when a country is given", () => {
		expect(buildSerpUrl("bing", "pizza", { numResults: 25 })).toBe(
			"https://www.bing.com/search?q=pizza&count=25",
		);
		expect(buildSerpUrl("bing", "pizza", { country: "gb" })).toContain(
			"mkt=en_GB",
		);
	});

	test("builds a Yandex URL", () => {
		expect(buildSerpUrl("yandex", "pizza", {})).toBe(
			"https://yandex.com/search/?text=pizza&numdoc=10",
		);
	});

	test("encodes and trims the query", () => {
		expect(buildSerpUrl("google", "  a & b  ", {})).toContain("q=a%20%26%20b&");
	});
});

describe("requestBody", () => {
	test("defaults format to raw and keeps the target url", () => {
		expect(requestBody("https://x.com", "sdk_unlocker", {}, "GET")).toEqual({
			url: "https://x.com",
			zone: "sdk_unlocker",
			method: "GET",
			format: "raw",
		});
	});

	test("omits data_format for the default html", () => {
		const body = requestBody(
			"https://x.com",
			"z",
			{ dataFormat: "html" },
			"GET",
		);
		expect(Object.hasOwn(body, "data_format")).toBe(false);
	});

	test("sends data_format when it is not html", () => {
		expect(
			requestBody("https://x.com", "z", { dataFormat: "markdown" }, "GET"),
		).toMatchObject({ data_format: "markdown" });
	});

	test("expands the md alias the API does not accept", () => {
		expect(
			requestBody("https://x.com", "z", { dataFormat: "md" }, "GET"),
		).toMatchObject({ data_format: "markdown" });
	});

	test("omits country when unset rather than sending undefined", () => {
		const body = requestBody("https://x.com", "z", {}, "GET");
		expect(Object.hasOwn(body, "country")).toBe(false);
	});
});

describe("parseBody", () => {
	test("parses a JSON object or array", () => {
		expect(parseBody('{"a":1}')).toEqual({ a: 1 });
		expect(parseBody("[1,2]")).toEqual([1, 2]);
	});

	test("leaves HTML as a string", () => {
		expect(parseBody("<html><body>hi</body></html>")).toBe(
			"<html><body>hi</body></html>",
		);
	});

	test("leaves malformed JSON as text rather than throwing", () => {
		expect(parseBody('{"a":')).toBe('{"a":');
	});
});
