import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("version pins", () => {
	test("every version pinned in code is tracked by `just pins`", () => {
		// A pin nobody checks is a pin that silently goes stale, so adding one
		// without listing it in scripts/pins.ts fails here.
		const tracker = readFileSync(
			new URL("../scripts/pins.ts", import.meta.url),
			"utf8",
		);
		const untracked: string[] = [];
		for (const path of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
			if (path.endsWith(".test.ts")) continue;
			const source = readFileSync(`${import.meta.dir}/${path}`, "utf8");
			for (const match of source.matchAll(
				/export const (\w+_VERSION) = "\d+\.\d+\.\d+"/g,
			)) {
				if (!tracker.includes(match[1] as string)) {
					untracked.push(`${match[1]} in src/${path}`);
				}
			}
		}
		expect(untracked).toEqual([]);
	});
});
