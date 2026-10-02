/**
 * `infer each` — run a command once per JSONL row, resumably.
 */

import { join, resolve } from "node:path";
import { Console, Duration, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { dryRun, EachError, type OutputLine, runEach } from "../each.ts";
import { emitJson } from "../output.ts";
import { cacheDir } from "../stage.ts";

const line = (value: unknown) => Console.log(JSON.stringify(value));

export const eachCmd = Command.make(
	"each",
	{
		input: Argument.String("input").pipe(
			Argument.withDescription(
				'A JSONL file: one JSON object per line, like {"url":"https://example.com","id":"a"}. Blank lines are skipped; any other line that is not an object stops the run before anything starts. - reads stdin.',
			),
		),
		command: Argument.String("command").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"The command to run for each row, after --. {field} is replaced by that field of the row ({a.b} for a nested field, {tags.0} for an array item); objects and arrays are written as JSON. Each argument is filled on its own and run without a shell, so a value with spaces or quotes stays one argument and nothing in it is interpreted — do not add quotes around placeholders for safety.",
			),
		),
		concurrency: Flag.Int("concurrency").pipe(
			Flag.withAlias("c"),
			Flag.withMetavar("n"),
			Flag.withDefault(4),
			Flag.withDescription(
				"How many rows run at the same time. Defaults to 4. Raise it for slow network-bound commands such as scrapes; keep it low for heavy local work such as renders, and mind provider rate limits.",
			),
		),
		retries: Flag.Int("retries").pipe(
			Flag.withMetavar("n"),
			Flag.withDefault(2),
			Flag.withDescription(
				"Extra attempts for a row whose command exits non-zero or times out, waiting about 1 s, then 2 s, 4 s... between them. Defaults to 2 (three attempts in all). 0 tries each row once. A command that cannot be started at all is not retried.",
			),
		),
		timeout: Flag.Int("timeout").pipe(
			Flag.withMetavar("seconds"),
			Flag.optional,
			Flag.withDescription(
				"Kill a row's command after this many seconds and count it as a failed attempt (it is retried). No limit by default.",
			),
		),
		fresh: Flag.Boolean("fresh").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Forget the results kept from earlier runs of this same command and run every row again. Without it, rows that already succeeded are reused and not re-run (or re-billed).",
			),
		),
		dryRun: Flag.Boolean("dry-run").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Run nothing: print each row's filled command as {line,row,argv,reused} — reused true when a kept result would be used instead of running it — or {line,row,error} for a row missing a field. Free; use it to check placeholders before a paid run.",
			),
		),
		json: Flag.Boolean("json").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Print one JSON array of the output lines, at the end, instead of JSONL as rows finish. Same objects, same order.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			if (config.concurrency < 1) {
				return yield* Effect.fail(
					new EachError({ reason: "--concurrency must be at least 1." }),
				);
			}
			if (config.retries < 0) {
				return yield* Effect.fail(
					new EachError({ reason: "--retries cannot be negative." }),
				);
			}
			if (Option.exists(config.timeout, (seconds) => seconds < 1)) {
				return yield* Effect.fail(
					new EachError({ reason: "--timeout must be at least 1 second." }),
				);
			}
			const options = {
				input: config.input === "-" ? "-" : resolve(config.input),
				template: config.command,
				concurrency: config.concurrency,
				retries: config.retries,
				retryDelay: "1 second",
				timeout: Option.map(config.timeout, Duration.seconds),
				fresh: config.fresh,
				cwd: process.cwd(),
				journalDir: join(cacheDir(), "each"),
			} as const;

			if (config.dryRun) {
				const plan = yield* dryRun(options);
				if (config.json) return yield* emitJson(plan);
				return yield* Effect.forEach(plan, line, { discard: true });
			}

			const collected: Array<OutputLine> = [];
			const summary = yield* runEach(
				options,
				config.json
					? (output) => Effect.sync(() => void collected.push(output))
					: line,
			);
			if (config.json) yield* emitJson(collected);
			const problems = [
				summary.failed > 0
					? `${summary.failed} of ${summary.rows} rows failed (ok:false, with the error, in the output). Run the same command again to retry only those — ${summary.ok === 1 ? "the 1 row that succeeded is" : `the ${summary.ok} rows that succeeded are`} kept and not re-run.`
					: null,
				summary.missing > 0
					? `${summary.missing} of ${summary.rows} rows lack a field the command uses, so nothing ran for them. Fix those rows in the input; re-running as is will not help.`
					: null,
			].filter((problem) => problem !== null);
			if (problems.length > 0) {
				return yield* Effect.fail(
					new EachError({ reason: problems.join("\n") }),
				);
			}
		}),
).pipe(
	Command.withShortDescription("Run a command once per JSONL row, resumably."),
	Command.withDescription(
		`Run a command once for every row of a JSONL file, filling {field}
placeholders from the row — instead of writing a shell loop. Built for
running an infer command over a list: scrape many URLs, capture many pages,
run one prompt per item.

Output is JSONL on stdout, one line per input row, in input order:
  {"line":1,"row":{...},"ok":true,"result":...,"reused":false}
  {"line":2,"row":{...},"ok":false,"error":"...","exitCode":1,"attempts":3}
result is the command's stdout, parsed when it is JSON and a string
otherwise — so pass --json to infer commands to get structured results.
line is the row's line number in the input. Progress goes to stderr.

Results are kept. Every success is saved the moment it lands, under
~/.cache/infer/each (XDG_CACHE_HOME is honoured), keyed by the exact filled
command. Running the same infer each again — same command, same directory —
reuses every row that already succeeded and runs only the missing and failed
ones, so an interrupted or partly failed run is finished by re-running it,
as many times as needed, without paying twice. Edited rows fill to a new
command and run; untouched ones are reused. Rows that fill to the identical
command run once and share the result. --fresh forgets the kept results and
runs everything.

Kept means the command exited 0. A result that exited 0 but is not what you
wanted — an empty answer, a file you have since deleted — is still reused;
use --fresh, or change the command, to run it again.

Exits 0 only when every row succeeded. Otherwise every line is still
printed, and the exit is 1 with a summary on stderr.`,
	),
	Command.withExamples([
		{
			command:
				"infer each urls.jsonl -c 8 -- infer bdata scrape {url} --data-format markdown --json > pages.jsonl",
			description:
				"Scrape every URL, 8 at a time; re-run the same line to finish any that failed",
		},
		{
			command:
				"infer each pages.jsonl -- infer shot {url} -o shots/{id}.png --json",
			description: "Screenshot a list of pages, one file per row",
		},
		{
			command:
				"infer each items.jsonl --dry-run -- infer openrouter response openai/gpt-5-mini --prompt 'Summarise: {text}' --json",
			description: "Check the filled commands before paying for them",
		},
		{
			command: "jq -c '.[]' list.json | infer each - -- echo {name}",
			description: "Read rows from stdin",
		},
	]),
);
