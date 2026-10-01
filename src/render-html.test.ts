import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { embedAssets } from "./render.ts";
import {
	assetRef,
	dataUri,
	hasDefaultExport,
	htmlDocument,
	prependToHead,
	replaceJsonStrings,
	replaceStringLiterals,
} from "./render-html.ts";

describe("assetRef", () => {
	test("treats ./x, /x and x as the same file", () => {
		expect(assetRef("./img/a.png")).toBe("img/a.png");
		expect(assetRef("/img/a.png")).toBe("img/a.png");
		expect(assetRef("img/a.png")).toBe("img/a.png");
	});

	test("rejects anything already addressable", () => {
		for (const value of [
			"https://x.com/a.png",
			"data:image/png;base64,AA",
			"blob:abc",
			"//cdn.x.com/a.png",
			"#section",
		]) {
			expect(assetRef(value)).toBeNull();
		}
	});

	test("rejects text that cannot be a path before touching the disk", () => {
		expect(assetRef("")).toBeNull();
		expect(assetRef("./")).toBeNull();
		expect(assetRef("line one\nline two")).toBeNull();
		expect(assetRef("x".repeat(600))).toBeNull();
	});
});

describe("replaceStringLiterals", () => {
	const swap = (value: string) => (value === "a.png" ? "DATA" : null);

	test("replaces mapped literals in either quote style, keeping the quote", () => {
		expect(replaceStringLiterals(`f("a.png", 'a.png')`, swap)).toBe(
			`f("DATA", 'DATA')`,
		);
	});

	test("leaves unmapped literals and code untouched", () => {
		const code = `const s = "b.png"; const n = 1;`;
		expect(replaceStringLiterals(code, swap)).toBe(code);
	});

	test("does not touch strings whose source text is not their value", () => {
		const code = `x("a\\u002epng")`;
		expect(replaceStringLiterals(code, swap)).toBe(code);
	});
});

describe("replaceJsonStrings", () => {
	test("reaches strings at any depth and leaves other values alone", () => {
		const swap = (value: string) => (value === "a.png" ? "DATA" : null);
		expect(
			replaceJsonStrings(
				{ logo: "a.png", n: 1, list: ["a.png", "b"], deep: { x: "a.png" } },
				swap,
			),
		).toEqual({ logo: "DATA", n: 1, list: ["DATA", "b"], deep: { x: "DATA" } });
	});
});

describe("hasDefaultExport", () => {
	test("recognises both forms Bun emits", () => {
		expect(hasDefaultExport("export default function A() {}")).toBe(true);
		expect(hasDefaultExport("export {\n  A as default\n};")).toBe(true);
	});

	test("is false when only named exports exist", () => {
		expect(hasDefaultExport("export { A };")).toBe(false);
	});
});

describe("htmlDocument", () => {
	const doc = (overrides: Partial<Parameters<typeof htmlDocument>[0]> = {}) =>
		htmlDocument({ title: "t", props: {}, stylesheet: false, ...overrides });

	test("carries props as JSON that cannot close its own element", () => {
		const html = doc({
			props: { title: "</script><script>alert(1)</script>" },
		});
		const slot = html.match(
			/<script id="infer-props" type="application\/json">(.*?)<\/script>/,
		);
		expect(slot).not.toBeNull();
		expect(JSON.parse(slot?.[1] ?? "").title).toBe(
			"</script><script>alert(1)</script>",
		);
	});

	test("escapes the title", () => {
		expect(doc({ title: "a <b> & c" })).toContain(
			"<title>a &lt;b> &amp; c</title>",
		);
	});

	test("links the composition's CSS only when it imported some", () => {
		expect(doc()).not.toContain("composition.css");
		expect(doc({ stylesheet: true })).toContain(
			'<link rel="stylesheet" href="./composition.css">',
		);
	});

	test("loads the entry as a relative module, so the build inlines it", () => {
		expect(doc()).toContain('<script type="module" src="./entry.ts"></script>');
	});

	test("puts --head after the reset, so it can override it", () => {
		const html = doc({ head: "<style>body{margin:8px}</style>" });
		expect(html.indexOf("body{margin:8px}")).toBeGreaterThan(
			html.indexOf("margin:0"),
		);
	});
});

describe("prependToHead", () => {
	test("inserts right after the opening tag, attributes or not", () => {
		expect(prependToHead("<html><head><title>t</title></head>", "X")).toBe(
			"<html><head>X<title>t</title></head>",
		);
		expect(prependToHead('<head lang="en"><b>', "X")).toBe(
			'<head lang="en">X<b>',
		);
	});

	test("is not fooled by an element whose name starts with head", () => {
		expect(prependToHead("<header></header><head></head>", "X")).toBe(
			"<header></header><head>X</head>",
		);
	});
});

describe("dataUri", () => {
	test("base64-encodes the bytes under the given type", () => {
		expect(dataUri("text/plain", new TextEncoder().encode("hi"))).toBe(
			"data:text/plain;base64,aGk=",
		);
	});
});

describe("embedAssets", () => {
	const root = mkdtempSync(join(tmpdir(), "infer-embed-"));
	const assets = join(root, "public");
	mkdirSync(join(assets, "img"), { recursive: true });
	writeFileSync(join(assets, "img", "a.png"), "PNGDATA");
	// A file beside the asset directory, which must never be reachable.
	writeFileSync(join(root, "secret.txt"), "TOKEN");
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const run = (code: string, props: unknown = {}) =>
		Effect.runPromise(embedAssets(code, props, assets));

	test("embeds a file named in the code and in the props", async () => {
		const result = await run(`f("img/a.png")`, { logo: "./img/a.png" });
		const expected = `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`;
		expect(result.code).toBe(`f("${expected}")`);
		expect(result.props).toEqual({ logo: expected });
	});

	test("never embeds a file outside the asset directory", async () => {
		const result = await run(`f("../secret.txt")`, { a: "../secret.txt" });
		expect(result.code).toBe(`f("../secret.txt")`);
		expect(JSON.stringify(result)).not.toContain(
			Buffer.from("TOKEN").toString("base64"),
		);
	});

	test("leaves strings that name no file alone", async () => {
		const result = await run(`f("a cat", "img/missing.png")`);
		expect(result.code).toBe(`f("a cat", "img/missing.png")`);
	});

	test("fails clearly when --assets is not a directory", async () => {
		await expect(
			Effect.runPromise(embedAssets("", {}, join(root, "nope"))),
		).rejects.toThrow("--assets is not a directory");
	});
});
