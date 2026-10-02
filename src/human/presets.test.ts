import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFormFields, toItems } from "./presets.ts";

describe("toItems", () => {
	test("strings and numbers are their own label, answered by position", () => {
		expect(toItems(["a", 2], {})).toEqual([
			{ id: 0, label: "a" },
			{ id: 1, label: "2" },
		]);
	});

	test("objects show the named fields and answer with the named id", () => {
		expect(
			toItems([{ key: "x1", title: "First", body: "line one\nline two" }], {
				label: "title",
				detail: "body",
				id: "key",
			}),
		).toEqual([
			{
				id: "x1",
				label: "First",
				detail: "line one\nline two",
				image: undefined,
			},
		]);
	});

	test("without --label, an object shows its first string field", () => {
		const [item] = toItems([{ n: 3, name: "Widget" }], {}) as ReadonlyArray<{
			label: string;
		}>;
		expect(item?.label).toBe("Widget");
	});

	test("structured detail is shown as indented JSON, not [object Object]", () => {
		const [item] = toItems([{ t: "a", meta: { k: 1 } }], {
			detail: "meta",
		}) as ReadonlyArray<{ detail?: string }>;
		expect(item?.detail).toBe('{\n  "k": 1\n}');
	});

	test("a local image is embedded; a URL is passed through", () => {
		const dir = mkdtempSync(join(tmpdir(), "infer-preset-"));
		try {
			const path = join(dir, "a.png");
			writeFileSync(path, "PNG");
			const items = toItems(
				[
					{ t: "local", img: path },
					{ t: "remote", img: "https://x.test/a.png" },
				],
				{ image: "img" },
			) as ReadonlyArray<{ image?: string }>;
			expect(items[0]?.image).toStartWith("data:image/png;base64,");
			expect(items[1]?.image).toBe("https://x.test/a.png");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("explains, rather than guesses, when the data does not fit", () => {
		expect(toItems([], {})).toContain("empty");
		expect(toItems([{ a: 1 }], { label: "title" })).toContain('no "title"');
		expect(toItems([{ k: 1 }, { k: 1 }], { id: "k" })).toContain("not unique");
		expect(toItems([{ k: { x: 1 } }], { id: "k" })).toContain(
			"string or a number",
		);
	});
});

describe("parseFormFields", () => {
	test("accepts a list of fields, or { fields: [...] }", () => {
		const spec = [{ name: "title", required: true }];
		expect(parseFormFields(spec)).toEqual(spec);
		expect(parseFormFields({ fields: spec })).toEqual(spec);
	});

	test("rejects what the page could not render", () => {
		expect(typeof parseFormFields([])).toBe("string");
		expect(typeof parseFormFields([{ name: "a", type: "date" }])).toBe(
			"string",
		);
		expect(parseFormFields([{ name: "a" }, { name: "a" }])).toContain(
			"duplicate",
		);
		expect(parseFormFields([{ name: "tone", type: "select" }])).toContain(
			"no options",
		);
	});
});
