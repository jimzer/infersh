import { describe, expect, test } from "bun:test";
import { compare, isDev, isNewer, normalize, VERSION } from "./version.ts";

describe("normalize", () => {
	test("strips a leading v", () => {
		expect(normalize("v1.2.3")).toBe("1.2.3");
		expect(normalize("1.2.3")).toBe("1.2.3");
	});

	test("trims surrounding whitespace", () => {
		expect(normalize("  v0.1.0\n")).toBe("0.1.0");
	});
});

describe("compare", () => {
	test("orders by each numeric segment", () => {
		expect(compare("1.0.0", "0.9.9")).toBeGreaterThan(0);
		expect(compare("0.9.9", "1.0.0")).toBeLessThan(0);
		expect(compare("1.2.3", "1.2.3")).toBe(0);
	});

	test("compares numerically, not lexically", () => {
		// The bug a string compare would hit: "10" < "9" alphabetically.
		expect(compare("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compare("2.0.0", "10.0.0")).toBeLessThan(0);
	});

	test("treats missing segments as zero", () => {
		expect(compare("1.2", "1.2.0")).toBe(0);
		expect(compare("1.2.1", "1.2")).toBeGreaterThan(0);
	});

	test("ignores a leading v on either side", () => {
		expect(compare("v1.2.3", "1.2.3")).toBe(0);
	});
});

describe("isNewer", () => {
	test("is strict — an equal version is not newer", () => {
		expect(isNewer("1.2.3", "1.2.3")).toBe(false);
		expect(isNewer("1.2.4", "1.2.3")).toBe(true);
		expect(isNewer("1.2.2", "1.2.3")).toBe(false);
	});

	test("handles the tag format GitHub releases use", () => {
		expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
	});
});

describe("VERSION", () => {
	test("is 'dev' when running from source", () => {
		// The bundle replaces __VERSION__ at build time; the test suite never is.
		expect(VERSION).toBe("dev");
		expect(isDev()).toBe(true);
	});

	test("a real version is not dev", () => {
		expect(isDev("0.2.0")).toBe(false);
	});
});
