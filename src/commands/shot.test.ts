import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "./shot.ts";

describe("normalizeUrl", () => {
	test("keeps a full http or https URL as it is", () => {
		expect(normalizeUrl("https://example.com/a?b=1")).toBe(
			"https://example.com/a?b=1",
		);
		expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
	});

	test("this machine gets http, because local dev servers rarely have TLS", () => {
		expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
		expect(normalizeUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
	});

	test("anything else gets https", () => {
		expect(normalizeUrl("example.com/docs")).toBe("https://example.com/docs");
	});

	test("rejects schemes a browser page capture cannot mean", () => {
		expect(normalizeUrl("ftp://example.com")).toBeNull();
		expect(normalizeUrl("file:///etc/passwd")).toBeNull();
	});
});
