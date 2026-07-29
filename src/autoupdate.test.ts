import { describe, expect, test } from "bun:test";
import {
	cachePath,
	isStale,
	modeFor,
	parseCache,
	TTL_MS,
} from "./autoupdate.ts";

const mode = (
	env: Record<string, string | undefined>,
	version = "0.2.3",
	interactive = true,
) => modeFor({ version, env, interactive });

describe("modeFor", () => {
	test("notifies by default in an interactive terminal", () => {
		expect(mode({})).toBe("notify");
	});

	test("stays silent when output is piped", () => {
		expect(mode({}, "0.2.3", false)).toBe("off");
	});

	test("never runs from a source checkout", () => {
		expect(mode({}, "dev")).toBe("off");
		expect(mode({ INFER_AUTO_UPDATE: "1" }, "dev")).toBe("off");
	});

	test("is disabled by INFER_NO_UPDATE_CHECK", () => {
		expect(mode({ INFER_NO_UPDATE_CHECK: "1" })).toBe("off");
	});

	test("is disabled in CI, even when auto-update is requested", () => {
		expect(mode({ CI: "true" })).toBe("off");
		expect(mode({ CI: "true", INFER_AUTO_UPDATE: "1" })).toBe("off");
	});

	test("auto-installs only when explicitly opted in", () => {
		expect(mode({ INFER_AUTO_UPDATE: "1" })).toBe("auto");
	});

	test("auto-installs even when piped, since it was asked for", () => {
		expect(mode({ INFER_AUTO_UPDATE: "1" }, "0.2.3", false)).toBe("auto");
	});

	test("treats empty, 0 and false as unset", () => {
		expect(mode({ INFER_AUTO_UPDATE: "" })).toBe("notify");
		expect(mode({ INFER_AUTO_UPDATE: "0" })).toBe("notify");
		expect(mode({ INFER_AUTO_UPDATE: "false" })).toBe("notify");
		expect(mode({ INFER_NO_UPDATE_CHECK: "0" })).toBe("notify");
	});
});

describe("isStale", () => {
	const now = 1_000_000_000_000;

	test("is fresh within the TTL", () => {
		expect(isStale(now - 1000, now)).toBe(false);
		expect(isStale(now - (TTL_MS - 1), now)).toBe(false);
	});

	test("is stale at and beyond the TTL", () => {
		expect(isStale(now - TTL_MS, now)).toBe(true);
		expect(isStale(now - TTL_MS * 3, now)).toBe(true);
	});

	test("a clock jumping backwards does not wedge the check", () => {
		// A future timestamp yields a negative age, which reads as fresh rather
		// than looping on every invocation.
		expect(isStale(now + TTL_MS, now)).toBe(false);
	});
});

describe("parseCache", () => {
	test("reads a well-formed entry", () => {
		expect(parseCache('{"checkedAt":123,"latest":"0.3.0"}')).toEqual({
			checkedAt: 123,
			latest: "0.3.0",
		});
	});

	test("rejects malformed or partial entries instead of throwing", () => {
		expect(parseCache("not json")).toBeNull();
		expect(parseCache("{}")).toBeNull();
		expect(parseCache('{"checkedAt":"soon","latest":"0.3.0"}')).toBeNull();
		expect(parseCache('{"checkedAt":123}')).toBeNull();
		expect(parseCache('{"checkedAt":123,"latest":""}')).toBeNull();
	});
});

describe("cachePath", () => {
	test("honours XDG_CACHE_HOME", () => {
		expect(cachePath({ XDG_CACHE_HOME: "/tmp/cache" })).toBe(
			"/tmp/cache/infer/update-check.json",
		);
	});

	test("falls back to ~/.cache", () => {
		expect(cachePath({})).toMatch(/\/\.cache\/infer\/update-check\.json$/);
	});
});
