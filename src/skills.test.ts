import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
	findAncestorClaude,
	layer,
	planTarget,
	RETIRED_FILES,
	SKILL_FILES,
	SKILL_NAME,
	Skills,
	skillDir,
} from "./skills.ts";

/** An `exists` predicate over a fixed set of paths. */
const fs = (...paths: string[]) => {
	const set = new Set(paths);
	return (path: string) => set.has(path);
};

describe("findAncestorClaude", () => {
	test("finds the nearest ancestor and stops there", () => {
		expect(findAncestorClaude("/a/b/c", fs("/a/.claude", "/a/b/.claude"))).toBe(
			"/a/b/.claude",
		);
	});

	test("ignores a .claude in the starting directory itself", () => {
		// planTarget checks the start separately, so the walk must begin above it.
		expect(findAncestorClaude("/a/b", fs("/a/b/.claude"))).toBeNull();
	});

	test("returns null when nothing is found up to the root", () => {
		expect(findAncestorClaude("/a/b/c", fs())).toBeNull();
	});

	test("terminates at the filesystem root", () => {
		expect(findAncestorClaude("/", fs())).toBeNull();
	});
});

describe("planTarget", () => {
	test("uses .claude in the current directory without asking", () => {
		expect(planTarget({ cwd: "/a/b", exists: fs("/a/b/.claude") })).toEqual({
			kind: "existing",
			claudeDir: "/a/b/.claude",
		});
	});

	test("offers to create one when nothing exists anywhere", () => {
		expect(planTarget({ cwd: "/a/b", exists: fs() })).toEqual({
			kind: "create",
			claudeDir: "/a/b/.claude",
		});
	});

	test("asks which to use when one exists further up", () => {
		expect(planTarget({ cwd: "/a/b/c", exists: fs("/a/.claude") })).toEqual({
			kind: "choose",
			here: "/a/b/c/.claude",
			ancestor: "/a/.claude",
		});
	});

	test("prefers the current directory over an ancestor", () => {
		// Being inside a larger project must not stop a nested one working.
		expect(
			planTarget({ cwd: "/a/b", exists: fs("/a/.claude", "/a/b/.claude") }),
		).toEqual({ kind: "existing", claudeDir: "/a/b/.claude" });
	});

	test("resolves a relative cwd to an absolute path", () => {
		const target = planTarget({ cwd: ".", exists: fs() });
		expect(target.kind).toBe("create");
		if (target.kind === "create") {
			expect(target.claudeDir.startsWith("/")).toBe(true);
		}
	});
});

describe("skillDir", () => {
	test("nests the skill under skills/<name>", () => {
		expect(skillDir("/a/.claude")).toBe(`/a/.claude/skills/${SKILL_NAME}`);
	});
});

describe("SKILL_FILES", () => {
	test("has a SKILL.md entry point plus references", () => {
		const paths = SKILL_FILES.map((f) => f.path);
		expect(paths).toContain("SKILL.md");
		expect(
			paths.filter((p) => p.startsWith("references/")).length,
		).toBeGreaterThan(0);
	});

	test("every file has content and valid frontmatter where required", () => {
		for (const file of SKILL_FILES) {
			expect(file.contents.length).toBeGreaterThan(100);
		}
		const entry = SKILL_FILES.find((f) => f.path === "SKILL.md");
		// The loader requires name and description in frontmatter.
		expect(entry?.contents.startsWith("---\n")).toBe(true);
		expect(entry?.contents).toContain(`name: ${SKILL_NAME}`);
		expect(entry?.contents).toContain("description:");
	});

	test("SKILL.md links to every reference file it ships", () => {
		const entry =
			SKILL_FILES.find((f) => f.path === "SKILL.md")?.contents ?? "";
		for (const file of SKILL_FILES) {
			if (file.path === "SKILL.md") continue;
			expect(entry).toContain(file.path);
		}
	});
});

describe("install", () => {
	test("removes files an older skill shipped, and nothing else", async () => {
		const claudeDir = mkdtempSync(join(tmpdir(), "infer-skill-"));
		try {
			const dir = skillDir(claudeDir);
			mkdirSync(join(dir, "references"), { recursive: true });
			writeFileSync(join(dir, "references", "ui.md"), "# infer ui");
			writeFileSync(join(dir, "references", "mine.md"), "the user's own");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Skills).install(claudeDir, false);
				}).pipe(Effect.provide(layer)),
			);

			expect(result.removed).toEqual(["references/ui.md"]);
			expect(existsSync(join(dir, "references", "ui.md"))).toBe(false);
			expect(existsSync(join(dir, "references", "mine.md"))).toBe(true);
			expect(existsSync(join(dir, "references", "human.md"))).toBe(true);
		} finally {
			rmSync(claudeDir, { recursive: true, force: true });
		}
	});

	test("never retires a file it still ships", () => {
		const shipped = new Set(SKILL_FILES.map((file) => file.path));
		for (const path of RETIRED_FILES) expect(shipped.has(path)).toBe(false);
	});
});
