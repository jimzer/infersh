/**
 * `infer skills` — install the agent skill into a project.
 */

import { relative } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import {
	SKILL_FILES,
	SKILL_NAME,
	Skills,
	SkillsError,
	skillDir,
	type Target,
} from "../skills.ts";

/** Shows a path relative to the working directory when that is shorter. */
const display = (path: string): string => {
	const rel = relative(process.cwd(), path);
	return rel !== "" && !rel.startsWith("..") ? rel : path;
};

/**
 * Turns a plan into the `.claude` directory to install into.
 *
 * The two ambiguous cases are asked about rather than guessed: creating a
 * second `.claude` inside an existing project fragments it, and installing into
 * a parent project touches files the user may not have had in mind.
 */
const resolveClaudeDir = (
	target: Target,
	assumeYes: boolean,
): Effect.Effect<string | null, SkillsError, Prompt.Environment> =>
	Effect.gen(function* () {
		if (target.kind === "existing") return target.claudeDir;

		const interactive = process.stdin.isTTY === true;

		if (target.kind === "create") {
			if (assumeYes || !interactive) {
				if (!assumeYes) {
					yield* Console.error(
						`No .claude found; creating ${display(target.claudeDir)}.`,
					);
				}
				return target.claudeDir;
			}
			const ok = yield* Prompt.confirm({
				message: `No .claude directory here. Create ${display(target.claudeDir)}?`,
				initial: true,
			}).pipe(Effect.orElseSucceed(() => false));
			return ok ? target.claudeDir : null;
		}

		// A .claude exists further up but not here.
		if (assumeYes || !interactive) {
			yield* Console.error(
				`Found an existing project at ${display(target.ancestor)}; installing there.\nPass --here to install into this directory instead.`,
			);
			return target.ancestor;
		}
		const choice = yield* Prompt.select({
			message: "No .claude here, but a project was found further up",
			choices: [
				{
					title: `Use ${display(target.ancestor)}`,
					description: "install into the project this directory belongs to",
					value: target.ancestor,
				},
				{
					title: `Create ${display(target.here)}`,
					description: "start a separate project here",
					value: target.here,
				},
			],
		}).pipe(Effect.orElseSucceed(() => null));
		return choice;
	});

const addCmd = Command.make(
	"add",
	{
		force: Flag.boolean("force").pipe(
			Flag.withDescription(
				"Overwrite skill files that already exist. Without this, existing files are left alone so local edits survive.",
			),
		),
		here: Flag.boolean("here").pipe(
			Flag.withDescription(
				"Always use the current directory, creating .claude if needed, instead of an existing project found further up.",
			),
		),
		yes: Flag.boolean("yes").pipe(
			Flag.withAlias("y"),
			Flag.withDescription(
				"Do not ask; take the default choice. Implied when there is no terminal, so this is safe to run from a script.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const skills = yield* Skills;
			const planned = yield* skills.plan(process.cwd());

			const target: Target =
				config.here && planned.kind === "choose"
					? { kind: "create", claudeDir: planned.here }
					: planned;

			const claudeDir = yield* resolveClaudeDir(target, config.yes);
			if (claudeDir === null) {
				return yield* Effect.fail(
					new SkillsError({ reason: "Cancelled; nothing was written." }),
				);
			}

			const result = yield* skills.install(claudeDir, config.force);

			for (const file of result.written) {
				yield* Console.error(`  wrote    ${file}`);
			}
			for (const file of result.skipped) {
				yield* Console.error(`  kept     ${file}`);
			}
			if (result.skipped.length > 0) {
				yield* Console.error("\nPass --force to overwrite the kept files.");
			}
			yield* Console.log(result.skillDir);
		}),
).pipe(
	Command.withShortDescription("Install the infer skill into a project."),
	Command.withDescription(
		`Write the infer agent skill into a project's .claude/skills directory.

The skill teaches an agent how to use this CLI: the composition contract
for rendering, the model-discovery order for fal, which flags bound a
billed quantity, and the traps in each provider. It is a folder — a short
SKILL.md that points into reference files, so only the relevant part gets
read.

Where it goes:

  .claude here            use it
  none anywhere           offer to create .claude here
  .claude further up      ask whether to use that project or start here

With no terminal, or with --yes, the default is taken without asking:
create here when nothing was found, or use the project found further up.
--here forces the current directory either way.

The skill ships inside the CLI, so this needs no network and \`infer
update\` brings a newer version of the skill with it.`,
	),
	Command.withExamples([
		{ command: "infer skills add", description: "Install into this project" },
		{
			command: "infer skills add --yes",
			description: "Install without prompting, for scripts and agents",
		},
		{
			command: "infer skills add --here",
			description: "Install into this directory, ignoring any parent project",
		},
		{
			command: "infer skills add --force",
			description: "Overwrite an already-installed skill",
		},
	]),
);

const listCmd = Command.make("list", {}, () =>
	Effect.gen(function* () {
		const skills = yield* Skills;
		const planned = yield* skills.plan(process.cwd());

		const claudeDir =
			planned.kind === "choose" ? planned.ancestor : planned.claudeDir;
		const dir = skillDir(claudeDir);

		yield* Console.log(`${SKILL_NAME}  ${display(dir)}`);
		for (const file of SKILL_FILES) {
			const installed = yield* Effect.tryPromise({
				try: () => Bun.file(`${dir}/${file.path}`).exists(),
				catch: () => new SkillsError({ reason: "Could not read the skill" }),
			});
			yield* Console.log(
				`  ${installed ? "installed" : "missing  "}  ${file.path}`,
			);
		}
		if (planned.kind !== "existing") {
			yield* Console.error(
				`\nNothing is installed yet. Run \`infer skills add\`.`,
			);
		}
	}),
).pipe(
	Command.withShortDescription("Show the skill and whether it is installed."),
	Command.withDescription(
		`List the files the infer skill is made of and whether each is present.

Resolves the same project directory \`add\` would use, so this is the
quickest way to see where a skill would land before writing anything.`,
	),
	Command.withExamples([
		{
			command: "infer skills list",
			description: "Check what is installed and where",
		},
	]),
);

export const skillsCmd = Command.make("skills").pipe(
	Command.withShortDescription("Install the infer agent skill."),
	Command.withDescription(
		`Install the skill that teaches an agent how to drive this CLI.

Skills are plain files under .claude/skills, so this is an offline copy
into the current project.`,
	),
	Command.withSubcommands([addCmd, listCmd]),
);
