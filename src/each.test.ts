import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Option, Result } from "effect";
import {
	type EachOptions,
	fill,
	inOrder,
	lookup,
	type OutputLine,
	parseJournal,
	parseOutput,
	parseRows,
	placeholders,
	runEach,
} from "./each.ts";

describe("parseRows", () => {
	test("one object per line, blank lines skipped, line numbers kept", () => {
		const rows = parseRows('{"a":1}\n\n  \n{"a":2}\n');
		expect(Result.getOrThrow(rows)).toEqual([
			{ line: 1, row: { a: 1 } },
			{ line: 4, row: { a: 2 } },
		]);
	});

	test("refuses the whole input on a line that is not an object", () => {
		for (const bad of ['{"a":1}\n[1,2]', '{"a":1}\n"text"', '{"a":1}\n{oops']) {
			const rows = parseRows(bad);
			expect(Result.isFailure(rows)).toBe(true);
			if (Result.isFailure(rows)) expect(rows.failure).toStartWith("Line 2 ");
		}
	});
});

describe("placeholders", () => {
	test("finds field names, nested paths and array items, once each", () => {
		expect(
			placeholders([
				"x",
				"{url}",
				"-o",
				"out/{id}-{url}.png",
				"{a.b}",
				"{tags.0}",
			]),
		).toEqual(["url", "id", "a.b", "tags.0"]);
	});

	test("leaves the braces of JSON written into an argument alone", () => {
		expect(placeholders(['{"prompt":"{topic}","n":1}', "{}", "{ x }"])).toEqual(
			["topic"],
		);
	});
});

describe("lookup", () => {
	test("walks objects and arrays", () => {
		const row = { a: { b: "deep" }, tags: ["first"] };
		expect(lookup(row, "a.b")).toBe("deep");
		expect(lookup(row, "tags.0")).toBe("first");
		expect(lookup(row, "a.c")).toBeUndefined();
	});

	test("only sees the row's own fields, never the prototype", () => {
		expect(lookup({}, "constructor")).toBeUndefined();
		expect(lookup({ a: "x" }, "a.length")).toBeUndefined();
	});
});

describe("fill", () => {
	test("fills each argument on its own, so values stay one argument", () => {
		const row = { q: `it's "quoted" $(rm -rf /) ; x`, n: 3, ok: false };
		expect(
			Result.getOrThrow(fill(["cmd", "{q}", "--n={n}", "{ok}"], row)),
		).toEqual(["cmd", `it's "quoted" $(rm -rf /) ; x`, "--n=3", "false"]);
	});

	test("writes objects and arrays as JSON", () => {
		const row = { o: { a: 1 }, l: [1, "x"] };
		expect(Result.getOrThrow(fill(["{o}", "{l}"], row))).toEqual([
			'{"a":1}',
			'[1,"x"]',
		]);
	});

	test("a value that itself looks like a placeholder is not filled again", () => {
		expect(Result.getOrThrow(fill(["{a}"], { a: "{b}", b: "no" }))).toEqual([
			"{b}",
		]);
	});

	test("reports every missing or null field", () => {
		const filled = fill(["{a}", "{b}", "{c}"], { a: "x", b: null });
		expect(Result.isFailure(filled) && filled.failure).toEqual(["b", "c"]);
	});

	test("an empty string is a value, not a missing field", () => {
		expect(Result.getOrThrow(fill(["[{a}]"], { a: "" }))).toEqual(["[]"]);
	});
});

describe("parseOutput", () => {
	test("JSON stdout becomes the value, anything else the trimmed text", () => {
		expect(parseOutput('{"a":1}\n')).toEqual({ a: 1 });
		expect(parseOutput("[1,2]")).toEqual([1, 2]);
		expect(parseOutput("/tmp/out.png\n")).toBe("/tmp/out.png");
		expect(parseOutput("")).toBe("");
	});
});

describe("parseJournal", () => {
	test("later entries win, and a half-written line is skipped", () => {
		const journal = [
			JSON.stringify({ key: "k1", argv: ["a"], result: 1 }),
			JSON.stringify({ key: "k2", argv: ["b"], result: { x: 2 } }),
			JSON.stringify({ key: "k1", argv: ["a"], result: 3 }),
			'{"key":"k3","argv":["c"],"res',
		].join("\n");
		const kept = parseJournal(journal);
		expect(kept.get("k1")).toBe(3);
		expect(kept.get("k2")).toEqual({ x: 2 });
		expect(kept.has("k3")).toBe(false);
	});
});

describe("inOrder", () => {
	test("releases values in index order however they arrive", () => {
		const release = inOrder<string>();
		expect(release(2, "c")).toEqual([]);
		expect(release(0, "a")).toEqual(["a"]);
		expect(release(1, "b")).toEqual(["b", "c"]);
		expect(release(3, "d")).toEqual(["d"]);
	});
});

describe("runEach", () => {
	// A command that counts its own runs, and fails for any id listed in a
	// file, so a test can make rows fail and then stop failing.
	const setup = () => {
		const dir = mkdtempSync(join(tmpdir(), "infer-each-test-"));
		const script = join(dir, "cmd.ts");
		writeFileSync(
			script,
			`import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [id, dir] = process.argv.slice(2);
appendFileSync(dir + "/runs", id + "\\n");
const failing = existsSync(dir + "/fail") ? readFileSync(dir + "/fail", "utf8").split(",") : [];
if (failing.includes(id)) { console.error("boom " + id); process.exit(3); }
console.log(JSON.stringify({ id, len: id.length }));`,
		);
		writeFileSync(
			join(dir, "rows.jsonl"),
			['{"id":"a"}', '{"id":"b b"}', '{"id":"c\\"q"}', '{"id":"a"}'].join("\n"),
		);
		const options: EachOptions = {
			input: join(dir, "rows.jsonl"),
			template: ["bun", script, "{id}", dir],
			concurrency: 2,
			retries: 1,
			retryDelay: "1 millis",
			timeout: Option.none(),
			fresh: false,
			cwd: dir,
			journalDir: join(dir, "journal"),
		};
		const runs = () =>
			existsSync(join(dir, "runs"))
				? readFileSync(join(dir, "runs"), "utf8").trim().split("\n")
				: [];
		const go = (overrides: Partial<EachOptions> = {}) => {
			const lines: Array<OutputLine> = [];
			return Effect.runPromise(
				runEach({ ...options, ...overrides }, (line) =>
					Effect.sync(() => void lines.push(line)),
				).pipe(
					Effect.map((summary) => ({ summary, lines })),
					Effect.provide(BunServices.layer),
					// Keep the progress lines out of the test output.
					Effect.provideService(
						Console.Console,
						Object.assign(Object.create(console), { error: () => {} }),
					),
				),
			);
		};
		return { dir, go, runs, cleanup: () => rmSync(dir, { recursive: true }) };
	};

	test("runs each distinct command once, in order, and resumes only what failed", async () => {
		const { dir, go, runs, cleanup } = setup();
		try {
			writeFileSync(join(dir, "fail"), "b b");
			const first = await go();
			expect(first.lines.map((line) => line.line)).toEqual([1, 2, 3, 4]);
			expect(first.lines.map((line) => line.ok)).toEqual([
				true,
				false,
				true,
				true,
			]);
			expect(first.lines[0]).toMatchObject({
				result: { id: "a", len: 1 },
				reused: false,
			});
			expect(first.lines[1]).toMatchObject({
				exitCode: 3,
				attempts: 2,
				error: "boom b b",
			});
			expect(first.lines[2]).toMatchObject({ result: { id: 'c"q' } });
			// "a" twice is one command; "b b" ran twice (one retry).
			expect(runs().sort()).toEqual(["a", "b b", "b b", 'c"q']);
			expect(first.summary).toMatchObject({ ok: 3, failed: 1, reused: 0 });

			rmSync(join(dir, "fail"));
			const second = await go();
			expect(second.lines.every((line) => line.ok)).toBe(true);
			expect(second.lines.map((line) => line.ok && line.reused)).toEqual([
				true,
				false,
				true,
				true,
			]);
			expect(runs().filter((id) => id === "b b")).toHaveLength(3);
			expect(runs()).toHaveLength(5);

			const third = await go();
			expect(third.summary).toMatchObject({ ok: 4, reused: 4, failed: 0 });
			expect(runs()).toHaveLength(5);

			const fresh = await go({ fresh: true });
			expect(fresh.summary).toMatchObject({ ok: 4, reused: 0 });
			expect(runs()).toHaveLength(8);
		} finally {
			cleanup();
		}
	});

	test("a different command template keeps its own results", async () => {
		const { go, runs, cleanup } = setup();
		try {
			await go();
			const other = await go({
				template: ["bun", "-e", "console.log(1)", "{id}"],
			});
			expect(other.lines.every((line) => line.ok && !line.reused)).toBe(true);
			expect(runs()).toHaveLength(3);
		} finally {
			cleanup();
		}
	});
});
