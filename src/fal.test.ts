import { describe, expect, test } from "bun:test";
import {
	collectCandidates,
	collectOutputAssets,
	extractInputSchema,
	looksLikePath,
	outputPaths,
	searchQuery,
	specUrl,
	substitute,
	urlFileName,
} from "./fal.ts";

const params = (over: Partial<Parameters<typeof searchQuery>[0]> = {}) => ({
	endpointIds: [],
	expand: [],
	...over,
});

describe("searchQuery", () => {
	test("is empty when nothing is set", () => {
		expect(searchQuery(params())).toBe("");
	});

	test("repeats the key for array-valued params", () => {
		const query = searchQuery(
			params({ endpointIds: ["fal-ai/flux/dev", "fal-ai/flux-pro"] }),
		);
		expect(query).toBe(
			"endpoint_id=fal-ai%2Fflux%2Fdev&endpoint_id=fal-ai%2Fflux-pro",
		);
	});

	test("carries the search filters", () => {
		const query = searchQuery(
			params({ q: "text to image", category: "text-to-image", limit: 5 }),
		);
		expect(query).toContain("q=text+to+image");
		expect(query).toContain("category=text-to-image");
		expect(query).toContain("limit=5");
	});

	test("keeps limit=0 rather than dropping it as falsy", () => {
		expect(searchQuery(params({ limit: 0 }))).toBe("limit=0");
	});
});

describe("specUrl", () => {
	test("encodes the slashes in an endpoint id", () => {
		expect(specUrl("fal-ai/flux/dev")).toBe(
			"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Fflux%2Fdev",
		);
	});
});

describe("looksLikePath", () => {
	test("accepts plausible paths", () => {
		expect(looksLikePath("./cat.png")).toBe(true);
		expect(looksLikePath("/tmp/a.jpg")).toBe(true);
		expect(looksLikePath("a prompt")).toBe(true);
	});

	test("skips things that are already addressable", () => {
		expect(looksLikePath("https://example.com/a.png")).toBe(false);
		expect(looksLikePath("http://example.com/a.png")).toBe(false);
		expect(looksLikePath("data:image/png;base64,AAAA")).toBe(false);
		expect(looksLikePath("file:///tmp/a.png")).toBe(false);
	});

	test("skips values that cannot be a filename", () => {
		expect(looksLikePath("")).toBe(false);
		expect(looksLikePath("a\nmultiline\nprompt")).toBe(false);
		expect(looksLikePath("x".repeat(5000))).toBe(false);
	});
});

describe("collectCandidates", () => {
	test("finds strings at any depth", () => {
		const found = collectCandidates({
			prompt: "a cat",
			image_url: "./cat.png",
			nested: { deep: [{ ref: "/tmp/b.jpg" }] },
		});
		expect(found).toContain("./cat.png");
		expect(found).toContain("/tmp/b.jpg");
		expect(found).toContain("a cat");
	});

	test("does not depend on the field being named like a file", () => {
		// The old name-based heuristic missed this; existence on disk decides.
		expect(collectCandidates({ whatever: "./cat.png" })).toContain("./cat.png");
	});

	test("deduplicates repeated values", () => {
		const found = collectCandidates(["./a.png", "./a.png", { x: "./a.png" }]);
		expect(found.filter((v) => v === "./a.png")).toHaveLength(1);
	});

	test("ignores URLs and non-strings", () => {
		const found = collectCandidates({
			url: "https://example.com/a.png",
			count: 3,
			flag: true,
			nothing: null,
		});
		expect(found).toEqual([]);
	});
});

describe("substitute", () => {
	const uploads = new Map([["./cat.png", "https://cdn/cat.png"]]);

	test("replaces matches at any depth", () => {
		expect(
			substitute(
				{ image_url: "./cat.png", list: ["./cat.png", "keep"] },
				uploads,
			),
		).toEqual({
			image_url: "https://cdn/cat.png",
			list: ["https://cdn/cat.png", "keep"],
		});
	});

	test("leaves everything else untouched", () => {
		const input = { prompt: "a cat", steps: 4, on: true, none: null };
		expect(substitute(input, uploads)).toEqual(input);
	});

	test("returns the input unchanged when nothing was uploaded", () => {
		const input = { image_url: "./cat.png" };
		expect(substitute(input, new Map())).toEqual(input);
	});
});

describe("collectOutputAssets", () => {
	test("finds assets whatever the surrounding field is called", () => {
		const assets = collectOutputAssets({
			images: [{ url: "https://cdn/a.jpg", content_type: "image/jpeg" }],
			video: { url: "https://cdn/b.mp4", file_name: "clip.mp4" },
		});
		expect(assets.map((a) => a.url)).toEqual([
			"https://cdn/a.jpg",
			"https://cdn/b.mp4",
		]);
		expect(assets[1]?.fileName).toBe("clip.mp4");
		expect(assets[0]?.contentType).toBe("image/jpeg");
	});

	test("preserves the order the model returned", () => {
		const assets = collectOutputAssets({
			images: [{ url: "https://cdn/1.jpg" }, { url: "https://cdn/2.jpg" }],
		});
		expect(assets.map((a) => a.url)).toEqual([
			"https://cdn/1.jpg",
			"https://cdn/2.jpg",
		]);
	});

	test("ignores non-URL url fields and plain metadata", () => {
		expect(
			collectOutputAssets({ seed: 42, prompt: "a cat", url: "not-a-url" }),
		).toEqual([]);
	});

	test("returns nothing for a text-only result", () => {
		expect(collectOutputAssets({ text: "hello" })).toEqual([]);
	});
});

describe("urlFileName", () => {
	test("takes the trailing name, ignoring the query string", () => {
		expect(urlFileName("https://cdn/files/b/x/cat.png?token=1")).toBe(
			"cat.png",
		);
	});

	test("gives up on a URL with no filename", () => {
		expect(urlFileName("https://cdn/")).toBeUndefined();
		expect(urlFileName("nonsense")).toBeUndefined();
	});
});

describe("outputPaths", () => {
	const asset = (url: string, fileName?: string) => ({ url, fileName });

	test("uses the target verbatim for a single asset", () => {
		expect(outputPaths("out.png", [asset("https://cdn/a.jpg")], false)).toEqual(
			["out.png"],
		);
	});

	test("numbers additional assets before the extension", () => {
		expect(
			outputPaths(
				"shots/out.png",
				[
					asset("https://cdn/a"),
					asset("https://cdn/b"),
					asset("https://cdn/c"),
				],
				false,
			),
		).toEqual(["shots/out.png", "shots/out-2.png", "shots/out-3.png"]);
	});

	test("appends a suffix when the target has no extension", () => {
		expect(
			outputPaths(
				"out",
				[asset("https://cdn/a"), asset("https://cdn/b")],
				false,
			),
		).toEqual(["out", "out-2"]);
	});

	test("is not fooled by a dot in a parent directory name", () => {
		expect(
			outputPaths(
				"my.dir/out",
				[asset("https://cdn/a"), asset("https://cdn/b")],
				false,
			),
		).toEqual(["my.dir/out", "my.dir/out-2"]);
	});

	test("keeps the model's filenames when the target is a directory", () => {
		expect(
			outputPaths(
				"shots",
				[asset("https://cdn/a.jpg", "first.jpg"), asset("https://cdn/b.png")],
				true,
			),
		).toEqual(["shots/first.jpg", "shots/b.png"]);
	});

	test("falls back to an index when a directory target has no usable name", () => {
		expect(outputPaths("shots", [asset("https://cdn/")], true)).toEqual([
			"shots/output-1",
		]);
	});
});

describe("extractInputSchema", () => {
	const spec = (paths: Record<string, unknown>) => ({ paths });
	const post = (schema: unknown) => ({
		post: { requestBody: { content: { "application/json": { schema } } } },
	});

	test("pulls properties and required from the submit endpoint", () => {
		const result = extractInputSchema(
			spec({
				"/": post({
					properties: { prompt: { type: "string" } },
					required: ["prompt"],
				}),
			}),
		);
		expect(result).toEqual({
			properties: { prompt: { type: "string" } },
			required: ["prompt"],
		});
	});

	test("skips queue-management paths that take no model input", () => {
		const result = extractInputSchema(
			spec({
				"/requests/{request_id}/cancel": post({ properties: { no: {} } }),
				"/": post({ properties: { prompt: {} }, required: [] }),
			}),
		);
		expect(result?.properties).toEqual({ prompt: {} });
	});

	test("defaults required to empty when the schema omits it", () => {
		const result = extractInputSchema(spec({ "/": post({ properties: {} }) }));
		expect(result?.required).toEqual([]);
	});

	test("returns null when there is no request body at all", () => {
		expect(extractInputSchema(spec({ "/": { get: {} } }))).toBeNull();
		expect(extractInputSchema({})).toBeNull();
	});
});
