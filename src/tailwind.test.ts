import { describe, expect, test } from "bun:test";
import {
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
