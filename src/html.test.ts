import { describe, expect, test } from "bun:test";
import { escapeForScript, escapeText, inlineScript } from "./html.ts";

describe("escapeForScript", () => {
	test("neutralises a closing tag hidden in the data", () => {
		const json = JSON.stringify({ post: "</script><script>alert(1)</script>" });
		const escaped = escapeForScript(json);
		expect(escaped).not.toContain("</script>");
		expect(JSON.parse(escaped).post).toBe("</script><script>alert(1)</script>");
	});

	test("leaves ordinary JSON parseable", () => {
		expect(JSON.parse(escapeForScript(JSON.stringify({ a: 1 })))).toEqual({
			a: 1,
		});
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

describe("escapeText", () => {
	test("escapes the two characters that matter in element content", () => {
		expect(escapeText("a < b & c")).toBe("a &lt; b &amp; c");
	});

	test("escapes & first, so it does not double-escape its own output", () => {
		expect(escapeText("<")).toBe("&lt;");
	});
});
