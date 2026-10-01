import { describe, expect, test } from "bun:test";
import {
	inlineScript,
	TAILWIND_NAME,
	TAILWIND_PACKAGE,
	TAILWIND_VERSION,
} from "./tailwind.ts";

describe("TAILWIND_PACKAGE", () => {
	test("pins an exact v4 version, never a range or a tag", () => {
		expect(TAILWIND_VERSION).toMatch(/^4\.\d+\.\d+$/);
		expect(TAILWIND_PACKAGE).toBe(`${TAILWIND_NAME}@${TAILWIND_VERSION}`);
	});
});

describe("inlineScript", () => {
	test("wraps code in a script element", () => {
		expect(inlineScript("var a=1;")).toBe("<script>var a=1;</script>");
	});

	test("cannot be closed early by a closing tag inside the code", () => {
		const html = inlineScript('var s="</script><img src=x onerror=alert(1)>";');
		// Exactly one real closing tag: the one inlineScript added.
		expect(html.match(/<\/script>/g)?.length).toBe(1);
		expect(html).toContain("<\\/script><img");
	});

	test("catches the closing tag in any case", () => {
		expect(inlineScript("'</SCRIPT>'")).toBe("<script>'<\\/SCRIPT>'</script>");
	});
});
