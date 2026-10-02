/**
 * `infer each` — one command per JSONL row, resumably.
 *
 * Each row fills `{field}` placeholders in a command template, argv element by
 * argv element, and the command runs without a shell. Every success is
 * appended to a journal in the cache directory, keyed by the filled command,
 * so running the same `infer each` again reuses what already succeeded and
 * only runs what is missing or failed (ADR 28).
 */

import { join } from "node:path";
import {
	Console,
	Crypto,
	Data,
	Duration,
	Effect,
	FileSystem,
	Option,
	Predicate,
	Ref,
	Result,
	Schedule,
	Schema,
	Semaphore,
	Stdio,
	Stream,
} from "effect";
import { Hex } from "effect/encoding";
import { decodeEach, JsonObject, JsonText } from "./json.ts";
import { run } from "./stage.ts";

export class EachError extends Data.TaggedError("EachError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

/** One attempt at a row's command that did not succeed. */
class AttemptFailed extends Data.TaggedError("AttemptFailed")<{
	readonly reason: string;
	readonly exitCode?: number;
	/** False when trying again cannot help, as with a command not installed. */
	readonly retryable: boolean;
}> {}

export type Row = { readonly [field: string]: unknown };

/** A row of the input, with its 1-based line number in the input. */
export interface InputRow {
	readonly line: number;
	readonly row: Row;
}

/* ------------------------------------------------------------------------ */
/* Input                                                                    */
/* ------------------------------------------------------------------------ */

const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));

const preview = (text: string, max = 80): string =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * Parses JSONL rows. Blank lines are skipped; any other line that is not a
 * JSON object fails the whole input, before anything runs — a half-run over a
 * malformed file is worse than a clear refusal.
 */
export const parseRows = (
	text: string,
): Result.Result<ReadonlyArray<InputRow>, string> => {
	const rows: Array<InputRow> = [];
	const lines = text.split("\n");
	for (const [i, raw] of lines.entries()) {
		const content = raw.trim();
		if (content === "") continue;
		const row = decodeRow(content);
		if (Option.isNone(row)) {
			return Result.fail(
				`Line ${i + 1} is not a JSON object: ${preview(content)}\nEach line must be one object, like {"url":"https://example.com"}.`,
			);
		}
		rows.push({ line: i + 1, row: row.value });
	}
	return Result.succeed(rows);
};

/* ------------------------------------------------------------------------ */
/* Placeholders                                                             */
/* ------------------------------------------------------------------------ */

/**
 * `{field}`, or `{a.b}` for a nested field and `{tags.0}` for an array item.
 *
 * A name must start with a letter or underscore, so JSON written into an
 * argument — `{"prompt":"{topic}"}` — leaves its own braces alone.
 */
const PLACEHOLDER = /\{([A-Za-z_][\w-]*(?:\.[\w-]+)*)\}/g;

/** The distinct field paths a template refers to, in order of appearance. */
export const placeholders = (
	template: ReadonlyArray<string>,
): ReadonlyArray<string> => [
	...new Set(
		template.flatMap((arg) =>
			[...arg.matchAll(PLACEHOLDER)].map((match) => match[1] as string),
		),
	),
];

/** A field's value by dotted path, through objects and arrays. */
export const lookup = (row: Row, path: string): unknown => {
	let value: unknown = row;
	for (const key of path.split(".")) {
		// Own properties only: `{constructor}` is a missing field, not Object.
		if (!Predicate.isObjectOrArray(value) || !Object.hasOwn(value, key)) {
			return undefined;
		}
		value = Reflect.get(value, key);
	}
	return value;
};

/**
 * How a value is written into an argument: strings as they are, numbers and
 * booleans as their text, objects and arrays as JSON. `null` and absent fields
 * have no sensible text, so they are reported rather than written as "null".
 */
const asArgument = (value: unknown): Option.Option<string> => {
	if (value === undefined || value === null) return Option.none();
	if (typeof value === "string") return Option.some(value);
	if (typeof value === "object") return Option.some(JSON.stringify(value));
	return Option.some(String(value));
};

/**
 * Fills a template from a row, one argv element at a time. The result is argv
 * for a direct exec — no shell ever sees it — so a value with spaces, quotes
 * or `$(…)` stays exactly one argument, literally. Fails with the fields the
 * row lacks.
 */
export const fill = (
	template: ReadonlyArray<string>,
	row: Row,
): Result.Result<ReadonlyArray<string>, ReadonlyArray<string>> => {
	const missing = placeholders(template).filter((path) =>
		Option.isNone(asArgument(lookup(row, path))),
	);
	if (missing.length > 0) return Result.fail(missing);
	return Result.succeed(
		template.map((arg) =>
			arg.replace(PLACEHOLDER, (_, path: string) =>
				Option.getOrElse(asArgument(lookup(row, path)), () => ""),
			),
		),
	);
};

export const missingMessage = (missing: ReadonlyArray<string>): string =>
	`Row has no value for ${missing.map((path) => `{${path}}`).join(", ")} (missing or null), so its command was not run.`;

/* ------------------------------------------------------------------------ */
/* Results                                                                  */
/* ------------------------------------------------------------------------ */

/** A command's stdout as the result: parsed when it is JSON, else the text. */
export const parseOutput = (stdout: string): unknown => {
	const text = stdout.trimEnd();
	return Option.getOrElse(
		Schema.decodeUnknownOption(JsonText)(text),
		() => text,
	);
};

const STDERR_LIMIT = 4000;

/** Why a command failed, from its stderr — the end of it, where errors are. */
export const failureReason = (stderr: string, code: number): string => {
	const text = stderr.trim();
	if (text === "")
		return `Exited with code ${code} and printed nothing on stderr.`;
	return text.length > STDERR_LIMIT
		? `…${text.slice(text.length - STDERR_LIMIT)}`
		: text;
};

/** One line of output: the row, and either its result or its error. */
export type OutputLine =
	| {
			readonly line: number;
			readonly row: Row;
			readonly ok: true;
			readonly result: unknown;
			/** True when the result was kept from an earlier run, not run now. */
			readonly reused: boolean;
	  }
	| {
			readonly line: number;
			readonly row: Row;
			readonly ok: false;
			readonly error: string;
			readonly exitCode?: number;
			readonly attempts: number;
	  };

/** A `--dry-run` line: what would run, and whether a result is already kept. */
export type PlanLine =
	| {
			readonly line: number;
			readonly row: Row;
			readonly argv: ReadonlyArray<string>;
			readonly reused: boolean;
	  }
	| { readonly line: number; readonly row: Row; readonly error: string };

/**
 * Releases values in index order as they arrive out of order: rows finish in
 * any order, but output line N is always input row N.
 */
export const inOrder = <A>(): ((index: number, value: A) => Array<A>) => {
	let next = 0;
	const pending = new Map<number, A>();
	return (index, value) => {
		pending.set(index, value);
		const ready: Array<A> = [];
		while (pending.has(next)) {
			ready.push(pending.get(next) as A);
			pending.delete(next);
			next++;
		}
		return ready;
	};
};

/* ------------------------------------------------------------------------ */
/* Journal                                                                  */
/* ------------------------------------------------------------------------ */

const JournalEntry = Schema.Struct({
	key: Schema.String,
	argv: Schema.Array(Schema.String),
	result: Schema.Unknown,
});

/**
 * The results a journal holds, by key. A line that does not decode — the
 * half-written last line of a run killed mid-write — is skipped, and that row
 * simply runs again. A later entry for a key replaces an earlier one.
 */
export const parseJournal = (text: string): ReadonlyMap<string, unknown> =>
	new Map(
		decodeEach(Schema.fromJsonString(JournalEntry))(
			text.split("\n").filter((line) => line.trim() !== ""),
		).map((entry) => [entry.key, entry.result]),
	);

const sha256 = Effect.fn("Each.sha256")(function* (text: string) {
	const crypto = yield* Crypto.Crypto;
	const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(text));
	return Hex.encode(bytes);
});

/**
 * The journal for one command template run from one directory. The directory
 * is part of it because a relative path in the command — `-o out/{id}.png` —
 * means a different file elsewhere.
 */
export const journalPath = Effect.fn("Each.journalPath")(function* (
	dir: string,
	cwd: string,
	template: ReadonlyArray<string>,
) {
	const hash = yield* sha256(JSON.stringify(["infer-each/1", cwd, template]));
	return join(dir, `${hash.slice(0, 16)}.jsonl`);
});

/** A row's key: its filled command. Rows that fill to the same command share one. */
const rowKey = (argv: ReadonlyArray<string>) => sha256(JSON.stringify(argv));

/* ------------------------------------------------------------------------ */
/* Running                                                                  */
/* ------------------------------------------------------------------------ */

export interface EachOptions {
	/** A JSONL file, or `-` for stdin. */
	readonly input: string;
	readonly template: ReadonlyArray<string>;
	readonly concurrency: number;
	/** Extra attempts after the first, for a row whose command fails. */
	readonly retries: number;
	/** First retry delay; each later one doubles, with jitter. */
	readonly retryDelay: Duration.Input;
	readonly timeout: Option.Option<Duration.Duration>;
	/** Forget kept results and run every row. */
	readonly fresh: boolean;
	readonly cwd: string;
	/** Where journals live: `<cacheDir>/each`. */
	readonly journalDir: string;
}

export interface EachSummary {
	readonly rows: number;
	readonly ok: number;
	readonly reused: number;
	/** Rows whose command failed, after every attempt. */
	readonly failed: number;
	/** Rows lacking a field their command needs; nothing ran for them. */
	readonly missing: number;
	readonly journal: string;
}

/** A distinct filled command and the rows (by position) that fill to it. */
interface Job {
	readonly key: string;
	readonly argv: ReadonlyArray<string>;
	readonly rows: Array<number>;
}

type Filled = Result.Result<Job, ReadonlyArray<string>>;

interface Plan {
	readonly rows: ReadonlyArray<InputRow>;
	/** Per row: its job's key, or the fields it is missing. */
	readonly filled: ReadonlyArray<Filled>;
	readonly jobs: ReadonlyArray<Job>;
	readonly kept: ReadonlyMap<string, unknown>;
	readonly journal: string;
}

const readInput = Effect.fn("Each.readInput")(function* (input: string) {
	if (input === "-") {
		const stdio = yield* Stdio.Stdio;
		return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
	}
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.readFileString(input);
});

const plan = Effect.fn("Each.plan")(function* (
	options: EachOptions,
	{ forget }: { readonly forget: boolean },
) {
	const text = yield* readInput(options.input).pipe(
		Effect.mapError(
			(cause) =>
				new EachError({
					reason: `Could not read ${options.input === "-" ? "stdin" : options.input}: ${cause.message}`,
				}),
		),
	);
	const rows = yield* Result.match(parseRows(text), {
		onFailure: (reason) => Effect.fail(new EachError({ reason })),
		onSuccess: Effect.succeed,
	});

	const jobs = new Map<string, Job>();
	const filled = yield* Effect.forEach(rows, ({ row }, index) =>
		Result.match(fill(options.template, row), {
			onFailure: (missing) => Effect.succeed<Filled>(Result.fail(missing)),
			onSuccess: (argv) =>
				rowKey(argv).pipe(
					Effect.map((key): Filled => {
						const job = jobs.get(key) ?? { key, argv, rows: [] };
						job.rows.push(index);
						jobs.set(key, job);
						return Result.succeed(job);
					}),
				),
		}),
	);

	const fs = yield* FileSystem.FileSystem;
	const journal = yield* journalPath(
		options.journalDir,
		options.cwd,
		options.template,
	);
	const exists = yield* fs
		.exists(journal)
		.pipe(Effect.orElseSucceed(() => false));
	if (exists && forget) {
		yield* fs.remove(journal).pipe(
			Effect.mapError(
				(cause) =>
					new EachError({
						reason: `Could not forget ${journal}: ${cause.message}`,
					}),
			),
		);
	}
	const kept =
		exists && !forget
			? parseJournal(
					yield* fs
						.readFileString(journal)
						.pipe(Effect.orElseSucceed(() => "")),
				)
			: new Map<string, unknown>();

	return {
		rows,
		filled,
		jobs: [...jobs.values()],
		kept,
		journal,
	} satisfies Plan;
});

/** What `--dry-run` prints: each row's filled command, and whether it would run. */
export const dryRun = Effect.fn("Each.dryRun")(function* (
	options: EachOptions,
) {
	const { rows, filled, kept } = yield* plan(options, { forget: false });
	return rows.map(({ line, row }, index): PlanLine => {
		const job = filled[index] as Filled;
		return Result.isFailure(job)
			? { line, row, error: missingMessage(job.failure) }
			: {
					line,
					row,
					argv: job.success.argv,
					reused: !options.fresh && kept.has(job.success.key),
				};
	});
});

/** A command for a progress line: its start and end, where the row's values usually are. */
const label = (argv: ReadonlyArray<string>): string => {
	const text = argv.join(" ");
	return text.length > 100 ? `${text.slice(0, 30)}…${text.slice(-69)}` : text;
};

/** One run of a command: its parsed stdout, or why it failed. */
const attempt = (argv: ReadonlyArray<string>, options: EachOptions) => {
	const [command = "", ...args] = argv;
	const once = run(command, args, { stdin: "ignore" }).pipe(
		Effect.mapError(
			(error) => new AttemptFailed({ reason: error.reason, retryable: false }),
		),
		Effect.flatMap((result) =>
			result.code === 0
				? Effect.succeed(parseOutput(result.stdout))
				: Effect.fail(
						new AttemptFailed({
							reason: failureReason(result.stderr, result.code),
							exitCode: result.code,
							retryable: true,
						}),
					),
		),
	);
	return Option.match(options.timeout, {
		onNone: () => once,
		onSome: (duration) =>
			once.pipe(
				Effect.timeoutOrElse({
					duration,
					orElse: () =>
						Effect.fail(
							new AttemptFailed({
								reason: `Timed out after ${Duration.format(duration)}; the command was killed.`,
								retryable: true,
							}),
						),
				}),
			),
	});
};

/**
 * Runs every row whose command has no kept result, `concurrency` at a time,
 * and hands each output line to `emit` in input order. A success is journaled
 * the moment it lands, so an interrupted run loses only what was in flight.
 */
export const runEach = Effect.fn("Each.run")(function* (
	options: EachOptions,
	emit: (line: OutputLine) => Effect.Effect<void>,
) {
	const { rows, filled, jobs, kept, journal } = yield* plan(options, {
		forget: options.fresh,
	});
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(options.journalDir, { recursive: true }).pipe(
		Effect.mapError(
			(cause) =>
				new EachError({
					reason: `Could not create ${options.journalDir}: ${cause.message}`,
				}),
		),
	);

	const toRun = jobs.filter((job) => !kept.has(job.key));
	const missing = filled.filter(Result.isFailure).length;
	const reusedRows = jobs
		.filter((job) => kept.has(job.key))
		.reduce((sum, job) => sum + job.rows.length, 0);
	yield* Console.error(
		[
			`each: ${rows.length} row${rows.length === 1 ? "" : "s"}`,
			reusedRows > 0 ? `${reusedRows} kept from an earlier run` : null,
			missing > 0 ? `${missing} missing a field` : null,
			`${toRun.length} command${toRun.length === 1 ? "" : "s"} to run, ${options.concurrency} at a time`,
		]
			.filter((part) => part !== null)
			.join(", "),
	);
	yield* Console.error(`each: results are kept in ${journal}`);

	// Output, journal appends and the counters go through one lock, so lines
	// leave in order and the journal is written one whole line at a time.
	const lock = yield* Semaphore.make(1);
	const release = inOrder<OutputLine>();
	const counts = yield* Ref.make({ ok: 0, failed: 0, reused: 0 });
	const record = (index: number, outcome: OutputLine) =>
		Effect.gen(function* () {
			yield* Ref.update(counts, (c) =>
				outcome.ok
					? {
							...c,
							ok: c.ok + 1,
							reused: c.reused + (outcome.reused ? 1 : 0),
						}
					: outcome.attempts === 0
						? c
						: { ...c, failed: c.failed + 1 },
			);
			yield* Effect.forEach(release(index, outcome), emit, { discard: true });
		});
	const forRows = (
		job: Job,
		outcome: (input: InputRow) => OutputLine,
	): Effect.Effect<void> =>
		Effect.forEach(
			job.rows,
			(index) => record(index, outcome(rows[index] as InputRow)),
			{ discard: true },
		);

	yield* lock.withPermits(1)(
		Effect.forEach(
			rows,
			({ line, row }, index) => {
				const job = filled[index] as Filled;
				if (Result.isFailure(job)) {
					return record(index, {
						line,
						row,
						ok: false,
						error: missingMessage(job.failure),
						attempts: 0,
					});
				}
				return kept.has(job.success.key)
					? record(index, {
							line,
							row,
							ok: true,
							result: kept.get(job.success.key),
							reused: true,
						})
					: Effect.void;
			},
			{ discard: true },
		),
	);

	const done = yield* Ref.make(0);
	const progress = (job: Job, status: string, detail?: string) =>
		Ref.updateAndGet(done, (n) => n + 1).pipe(
			Effect.flatMap((n) =>
				Console.error(
					`[${n}/${toRun.length}] ${status} line ${(rows[job.rows[0] as number] as InputRow).line}: ${label(job.argv)}${detail === undefined ? "" : `\n    ${detail}`}`,
				),
			),
		);

	yield* Effect.forEach(
		toRun,
		(job) =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0);
				const outcome = yield* Ref.update(attempts, (n) => n + 1).pipe(
					Effect.andThen(attempt(job.argv, options)),
					Effect.retry({
						schedule: Schedule.exponential(options.retryDelay).pipe(
							Schedule.jittered,
						),
						times: options.retries,
						while: (error) => error.retryable,
					}),
					Effect.result,
				);
				const tries = yield* Ref.get(attempts);
				if (Result.isSuccess(outcome)) {
					const entry = JSON.stringify({
						key: job.key,
						argv: job.argv,
						result: outcome.success,
					});
					yield* lock.withPermits(1)(
						fs.writeFileString(journal, `${entry}\n`, { flag: "a" }).pipe(
							Effect.catch((error) =>
								Console.error(
									`each: could not keep a result in ${journal}: ${error.message}`,
								),
							),
							Effect.andThen(
								forRows(job, ({ line, row }) => ({
									line,
									row,
									ok: true,
									result: outcome.success,
									reused: false,
								})),
							),
						),
					);
					yield* progress(job, "ok");
				} else {
					const error = outcome.failure;
					yield* lock.withPermits(1)(
						forRows(job, ({ line, row }) => ({
							line,
							row,
							ok: false,
							error: error.reason,
							...(error.exitCode === undefined
								? {}
								: { exitCode: error.exitCode }),
							attempts: tries,
						})),
					);
					yield* progress(
						job,
						`failed after ${tries} attempt${tries === 1 ? "" : "s"},`,
						preview(error.reason.split("\n").at(-1) ?? "", 160),
					);
				}
			}),
		{ concurrency: options.concurrency, discard: true },
	).pipe(
		// Ctrl-C and SIGTERM interrupt the whole CLI (main.ts), which closes
		// every running command's scope and kills it. Say what survives.
		Effect.onInterrupt(() =>
			Console.error(
				"each: stopped; the commands still running were killed. Every row that finished is kept: run the same command again to resume.",
			),
		),
	);

	const { ok, failed, reused } = yield* Ref.get(counts);
	yield* Console.error(
		`each: ${ok} ok (${reused} kept, ${ok - reused} ran now), ${failed} failed${missing > 0 ? `, ${missing} missing a field` : ""}`,
	);
	return {
		rows: rows.length,
		ok,
		reused,
		failed,
		missing,
		journal,
	} satisfies EachSummary;
});
