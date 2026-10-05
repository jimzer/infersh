import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dosDateTime,
	planZip,
	writeZip,
	type ZipEntry,
	type ZipOptions,
	zipNames,
} from "./ui-zip.ts";

const dir = mkdtempSync(join(tmpdir(), "infer-zip-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An entry served from memory, in chunks, as a file would be. */
const entry = (name: string, content: Uint8Array | string): ZipEntry => {
	const bytes =
		typeof content === "string" ? new TextEncoder().encode(content) : content;
	return {
		name,
		size: bytes.length,
		modified: new Date(2026, 9, 5, 14, 30, 12),
		open: async function* () {
			for (let at = 0; at < bytes.length; at += 1000) {
				yield bytes.subarray(at, at + 1000);
			}
		},
	};
};

const build = async (
	entries: ReadonlyArray<ZipEntry>,
	options?: ZipOptions,
): Promise<{ path: string; bytes: Uint8Array; planned: number }> => {
	const plan = planZip(entries, options);
	const chunks: Uint8Array[] = [];
	for await (const chunk of writeZip(plan)) chunks.push(chunk);
	const bytes = new Uint8Array(Buffer.concat(chunks));
	const path = join(dir, `${crypto.randomUUID()}.zip`);
	writeFileSync(path, bytes);
	return { path, bytes, planned: plan.size };
};

const unzip = (...args: string[]) => {
	const result = Bun.spawnSync(["unzip", ...args]);
	return {
		code: result.exitCode,
		out: result.stdout.toString(),
		bytes: result.stdout,
	};
};

const random = (size: number): Uint8Array =>
	crypto.getRandomValues(new Uint8Array(size));

describe("writeZip", () => {
	const text = "Bonjour, été.\n".repeat(500);
	const blob = random(65_536 + 17);

	for (const zip64 of ["auto", "always"] as const) {
		test(`writes an archive unzip -t accepts, ZIP64 ${zip64}`, async () => {
			const { path, bytes, planned } = await build(
				[entry("résumé été.txt", text), entry("data.bin", blob)],
				{ zip64 },
			);
			// The length promised in Content-Length is the length written.
			expect(bytes.length).toBe(planned);
			const tested = unzip("-t", path);
			expect(tested.code).toBe(0);
			expect(tested.out).toContain("No errors detected");
			expect(unzip("-p", path, "data.bin").bytes).toEqual(Buffer.from(blob));
			expect(unzip("-p", path, "résumé été.txt").out).toBe(text);
		});
	}

	test("stores the names as UTF-8, flagged so", async () => {
		const name = new TextEncoder().encode("café ☕.txt");
		const { bytes } = await build([entry("café ☕.txt", "x")]);
		const view = new DataView(bytes.buffer);
		// Bit 11 of the general purpose flags, in the local header.
		expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
		expect(view.getUint16(26, true)).toBe(name.length);
		expect(bytes.subarray(30, 30 + name.length)).toEqual(name);
	});

	test("takes an empty file, and an archive of nothing", async () => {
		const empty = await build([entry("empty.txt", "")]);
		expect(unzip("-t", empty.path).code).toBe(0);
		const none = await build([]);
		expect(none.bytes.length).toBe(none.planned);
		// unzip calls an archive with no entries "empty" and exits 1.
		expect(unzip("-t", none.path).code).toBeLessThanOrEqual(1);
	});

	test("keeps the time, to unzip's two-second precision", async () => {
		const { path } = await build([entry("a.txt", "a")]);
		expect(unzip("-Z", "-T", path).out).toContain("20261005.143012");
	});

	test("fails rather than write an archive whose length was a lie", async () => {
		const short: ZipEntry = { ...entry("a.txt", "abc"), size: 10 };
		const long: ZipEntry = { ...entry("a.txt", "abcdef"), size: 3 };
		for (const wrong of [short, long]) {
			const drain = async () => {
				for await (const _ of writeZip(planZip([wrong]))) {
					// drained
				}
			};
			await expect(drain()).rejects.toThrow("changed size");
		}
	});
});

describe("planZip", () => {
	test("switches to ZIP64 only for an entry past 4 GB", () => {
		const big = { ...entry("big.bin", ""), size: 5 * 1024 ** 3 };
		const plan = planZip([entry("a.txt", "a"), big, entry("b.txt", "b")]);
		expect(plan.entries.map((item) => item.zip64)).toEqual([
			false,
			true,
			// Small, but it starts past 4 GB, so its offset needs ZIP64.
			true,
		]);
		expect(plan.zip64End).toBe(true);
	});

	test("writes no ZIP64 fields for an ordinary archive", () => {
		const plan = planZip([entry("a.txt", "a")]);
		expect(plan.entries[0]?.zip64).toBe(false);
		expect(plan.zip64End).toBe(false);
		expect(plan.size).toBe(30 + 5 + 1 + 16 + 46 + 5 + 22);
	});
});

describe("zipNames", () => {
	test("dedupes repeated names, ignoring case, keeping the extension", () => {
		expect(zipNames(["a.txt", "b.txt", "a.txt", "A.TXT", "a"])).toEqual([
			"a.txt",
			"b.txt",
			"a (2).txt",
			"A (3).TXT",
			"a",
		]);
	});

	test("keeps every name one segment inside the archive", () => {
		expect(zipNames(["../../x.txt", "a\\b.txt", "..", "", "a\nb"])).toEqual([
			"x.txt",
			"b.txt",
			"file",
			"file (2)",
			"a_b",
		]);
	});

	test("does not take a leading dot for an extension", () => {
		expect(zipNames([".env", ".env"])).toEqual([".env", ".env (2)"]);
	});
});

describe("dosDateTime", () => {
	test("packs a local date and time, seconds halved", () => {
		const { date, time } = dosDateTime(new Date(2026, 9, 5, 14, 30, 13));
		expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 5);
		expect(time).toBe((14 << 11) | (30 << 5) | 6);
	});

	test("clamps a date before 1980, which the format cannot hold", () => {
		expect(dosDateTime(new Date(1970, 0, 1))).toEqual({
			date: (1 << 5) | 1,
			time: 0,
		});
	});
});
