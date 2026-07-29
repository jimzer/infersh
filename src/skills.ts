/**
 * `infer skills` — install the agent skill into a project.
 *
 * The skill files are embedded as text, so installing needs no network and the
 * skill is versioned with the CLI: `infer update` brings a newer one along.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
// @ts-expect-error text import: Bun inlines the file contents as a string
import bdataMd from "./skills/references/bdata.md" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import falMd from "./skills/references/fal.md" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import groqMd from "./skills/references/groq.md" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import remotionMd from "./skills/references/remotion.md" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import renderMd from "./skills/references/render.md" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import skillMd from "./skills/SKILL.md" with { type: "text" };

export class SkillsError extends Data.TaggedError("SkillsError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

/** The skill's name, and therefore its directory under `.claude/skills`. */
export const SKILL_NAME = "infer";

/** Every file the skill is made of, relative to its own directory. */
export const SKILL_FILES: ReadonlyArray<{
	readonly path: string;
	readonly contents: string;
}> = [
	{ path: "SKILL.md", contents: skillMd as string },
	{ path: "references/render.md", contents: renderMd as string },
	{ path: "references/remotion.md", contents: remotionMd as string },
	{ path: "references/fal.md", contents: falMd as string },
	{ path: "references/bdata.md", contents: bdataMd as string },
	{ path: "references/groq.md", contents: groqMd as string },
];

/**
 * Where the skill should go, and whether the user has to be asked first.
 *
 * - `existing` — this directory already has `.claude`, so just use it.
 * - `create` — nothing found anywhere; offer to create `.claude` here.
 * - `choose` — no `.claude` here but one exists further up; the user picks,
 *   because silently installing into a parent project would be surprising and
 *   silently creating a second `.claude` would fragment the project.
 */
export type Target =
	| { readonly kind: "existing"; readonly claudeDir: string }
	| { readonly kind: "create"; readonly claudeDir: string }
	| {
			readonly kind: "choose";
			readonly here: string;
			readonly ancestor: string;
	  };

/** The nearest ancestor of `from` containing a `.claude` directory, if any. */
export const findAncestorClaude = (
	from: string,
	exists: (path: string) => boolean,
): string | null => {
	let dir = resolve(from);
	// Start above `from`: the caller has already checked `from` itself.
	for (;;) {
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
		if (exists(join(dir, ".claude"))) return join(dir, ".claude");
	}
};

export const planTarget = (options: {
	readonly cwd: string;
	readonly exists: (path: string) => boolean;
}): Target => {
	const here = join(resolve(options.cwd), ".claude");
	if (options.exists(here)) return { kind: "existing", claudeDir: here };

	const ancestor = findAncestorClaude(options.cwd, options.exists);
	if (ancestor === null) return { kind: "create", claudeDir: here };
	return { kind: "choose", here, ancestor };
};

/** Where the skill's files land, given the resolved `.claude` directory. */
export const skillDir = (claudeDir: string): string =>
	join(claudeDir, "skills", SKILL_NAME);

export interface InstallResult {
	readonly skillDir: string;
	readonly written: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<string>;
}

export interface SkillsShape {
	/** Resolve where the skill would go, without writing anything. */
	readonly plan: (cwd: string) => Effect.Effect<Target, SkillsError>;
	/** Write the skill, leaving existing files alone unless `force`. */
	readonly install: (
		claudeDir: string,
		force: boolean,
	) => Effect.Effect<InstallResult, SkillsError>;
}

export class Skills extends Context.Service<Skills, SkillsShape>()("Skills") {}

const make = (): SkillsShape => ({
	plan: (cwd) => Effect.sync(() => planTarget({ cwd, exists: existsSync })),

	install: (claudeDir, force) =>
		Effect.gen(function* () {
			const dir = skillDir(claudeDir);
			const written: string[] = [];
			const skipped: string[] = [];

			for (const file of SKILL_FILES) {
				const target = join(dir, file.path);
				if (!force && existsSync(target)) {
					skipped.push(file.path);
					continue;
				}
				yield* Effect.tryPromise({
					try: async () => {
						mkdirSync(dirname(target), { recursive: true });
						await Bun.write(target, file.contents);
					},
					catch: (cause) =>
						new SkillsError({ reason: `Could not write ${target}: ${cause}` }),
				});
				written.push(file.path);
			}

			return { skillDir: dir, written, skipped };
		}),
});

export const layer: Layer.Layer<Skills> = Layer.sync(Skills)(make);
