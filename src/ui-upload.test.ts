import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The flags are parsed CLI-side, into what the page server then applies.
import { parseAccept, parseSize } from "./human/presets.ts";
import {
	acceptsFile,
	createUploads,
	dedupeName,
	sanitizeName,
	type UploadRules,
} from "./ui-upload.ts";

describe("sanitizeName", () => {
	test("keeps an ordinary name as it is", () => {
		expect(sanitizeName("Report 2026 (final).pdf")).toBe(
			"Report 2026 (final).pdf",
		);
		expect(sanitizeName("café.jpg")).toBe("café.jpg");
	});

	test("keeps only the last path segment, so no name climbs out", () => {
		expect(sanitizeName("../../.ssh/authorized_keys")).toBe("authorized_keys");
		expect(sanitizeName("C:\\Users\\me\\x.txt")).toBe("x.txt");
		expect(sanitizeName("/etc/passwd")).toBe("passwd");
	});

	test("never leaves a dot name, a hidden file or an empty one", () => {
		expect(sanitizeName("..")).toBe("file");
		expect(sanitizeName("../")).toBe("file");
		expect(sanitizeName(".env")).toBe("env");
		expect(sanitizeName("")).toBe("file");
		expect(sanitizeName("   ")).toBe("file");
	});

	test("replaces control and reserved characters", () => {
		expect(sanitizeName('a\u0000b\nc<d>:"e|f?g*.txt')).toBe(
			"a_b_c_d___e_f_g_.txt",
		);
	});

	test("cuts long names to 200 bytes, keeping the extension", () => {
		const name = sanitizeName(`${"é".repeat(300)}.mp4`);
		expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
		expect(name.endsWith(".mp4")).toBe(true);
	});
});

describe("dedupeName", () => {
	test("is the name itself when it is free", () => {
		expect(dedupeName("a.pdf", () => false)).toBe("a.pdf");
	});

	test("counts up from 2 before the extension", () => {
		const taken = new Set(["a.pdf", "a (2).pdf"]);
		expect(dedupeName("a.pdf", (c) => taken.has(c))).toBe("a (3).pdf");
		expect(dedupeName("README", (c) => c === "README")).toBe("README (2)");
	});
});

describe("parseAccept and acceptsFile", () => {
	test("splits, trims, lowercases, and dots a bare extension", () => {
		expect(parseAccept(" image/*, .PDF ,mov,,")).toEqual([
			"image/*",
			".pdf",
			".mov",
		]);
	});

	test("anything passes an empty list", () => {
		expect(acceptsFile([], "x.exe", "application/x-msdownload")).toBe(true);
	});

	test("extensions match the name, case-insensitively", () => {
		expect(acceptsFile([".pdf"], "Scan.PDF", "")).toBe(true);
		expect(acceptsFile([".pdf"], "scan.pdf.exe", "")).toBe(false);
	});

	test("type/* matches any subtype, a full type only itself", () => {
		expect(acceptsFile(["image/*"], "x", "image/heic")).toBe(true);
		expect(acceptsFile(["image/*"], "x", "imagex/heic")).toBe(false);
		expect(acceptsFile(["video/mp4"], "x", "video/mp4; codecs=avc1")).toBe(
			true,
		);
		expect(acceptsFile(["video/mp4"], "x", "video/quicktime")).toBe(false);
	});
});

describe("parseSize", () => {
	test("reads units in powers of 1024", () => {
		expect(parseSize("1024")).toBe(1024);
		expect(parseSize("500k")).toBe(500 * 1024);
		expect(parseSize("25MB")).toBe(25 * 1024 ** 2);
		expect(parseSize("1.5 GB")).toBe(1.5 * 1024 ** 3);
		expect(parseSize("2gib")).toBe(2 * 1024 ** 3);
	});

	test("refuses what is not a positive size", () => {
		expect(parseSize("big")).toBeUndefined();
		expect(parseSize("0")).toBeUndefined();
		expect(parseSize("-5MB")).toBeUndefined();
		expect(parseSize("5 parsecs")).toBeUndefined();
	});
});

describe("createUploads", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "infer-upload-test-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const rules = (overrides: Partial<UploadRules> = {}): UploadRules => ({
		dir,
		accept: [],
		...overrides,
	});

	const post = (
		body: BodyInit,
		name: string,
		headers: Record<string, string> = {},
	): Request =>
		new Request("http://x/api/upload", {
			method: "POST",
			body,
			headers: { "x-infer-name": encodeURIComponent(name), ...headers },
		});

	/** A body with no length, so only the streaming check can catch it. */
	const stream = (chunks: number, size: number): ReadableStream<Uint8Array> => {
		let sent = 0;
		return new ReadableStream({
			pull(controller) {
				if (sent++ === chunks) controller.close();
				else controller.enqueue(new Uint8Array(size).fill(7));
			},
		});
	};

	test("streams a file to its name, and keeps it when sent", async () => {
		const uploads = createUploads(rules());
		const response = await uploads.receive(post("hello", "notes.txt"));
		const saved = (await response.json()) as { id: string; size: number };
		expect(response.status).toBe(200);
		expect(saved.size).toBe(5);
		expect(readdirSync(dir)).toEqual(["notes.txt"]);
		expect(uploads.keep([saved.id])).toEqual([
			{
				path: join(dir, "notes.txt"),
				name: "notes.txt",
				size: 5,
				type: "text/plain",
			},
		]);
		expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("hello");
		// Kept files are no longer the run's to delete.
		uploads.discard();
		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
	});

	test("never overwrites: a taken name gets a number", async () => {
		writeFileSync(join(dir, "a.pdf"), "old");
		const uploads = createUploads(rules());
		await uploads.receive(post("one", "a.pdf"));
		await uploads.receive(post("two", "../a.pdf"));
		expect(readdirSync(dir).sort()).toEqual([
			"a (2).pdf",
			"a (3).pdf",
			"a.pdf",
		]);
		expect(readFileSync(join(dir, "a.pdf"), "utf8")).toBe("old");
	});

	test("refuses a type outside --accept, writing nothing", async () => {
		const uploads = createUploads(rules({ accept: ["image/*", ".pdf"] }));
		const response = await uploads.receive(
			post("x", "tool.exe", { "x-infer-type": "application/x-msdownload" }),
		);
		expect(response.status).toBe(415);
		expect(((await response.json()) as { error: string }).error).toContain(
			"tool.exe is not an accepted type",
		);
		// The extension stands in when the browser gave no type.
		expect((await uploads.receive(post("x", "photo.png"))).status).toBe(200);
		expect(readdirSync(dir)).toEqual(["photo.png"]);
	});

	test("refuses a file over --max-size by its length, before reading it", async () => {
		const uploads = createUploads(rules({ maxBytes: 4 }));
		const response = await uploads.receive(
			post("too long", "a.txt", { "content-length": "8" }),
		);
		expect(response.status).toBe(413);
		expect(((await response.json()) as { error: string }).error).toBe(
			"a.txt is 8 B, over the 4 B limit.",
		);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("stops a body with no length once it passes --max-size, and deletes it", async () => {
		const uploads = createUploads(rules({ maxBytes: 10_000 }));
		const response = await uploads.receive(post(stream(5, 4096), "big.bin"));
		expect(response.status).toBe(413);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("refuses a file past --max-files, counting removals back", async () => {
		const uploads = createUploads(rules({ maxFiles: 1 }));
		const first = (await (
			await uploads.receive(post("a", "a.txt"))
		).json()) as {
			id: string;
		};
		expect((await uploads.receive(post("b", "b.txt"))).status).toBe(409);
		expect(uploads.remove(first.id)).toBe(true);
		expect((await uploads.receive(post("b", "b.txt"))).status).toBe(200);
		expect(readdirSync(dir)).toEqual(["b.txt"]);
	});

	test("deletes what was not sent, and everything on discard", async () => {
		const uploads = createUploads(rules());
		const ids: string[] = [];
		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			const saved = (await (
				await uploads.receive(post(name, name))
			).json()) as {
				id: string;
			};
			ids.push(saved.id);
		}
		expect(
			uploads.keep([ids[2] ?? "", ids[0] ?? ""]).map((f) => f.name),
		).toEqual(["c.txt", "a.txt"]);
		expect(readdirSync(dir).sort()).toEqual(["a.txt", "c.txt"]);

		const other = createUploads(rules());
		await other.receive(post("d", "d.txt"));
		other.discard();
		expect(readdirSync(dir).sort()).toEqual(["a.txt", "c.txt"]);
	});

	test("an interrupted body leaves no partial file", async () => {
		const uploads = createUploads(rules());
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ < 3) controller.enqueue(new Uint8Array(1024));
				else controller.error(new Error("connection reset"));
			},
		});
		const response = await uploads.receive(post(body, "cut.bin"));
		expect(response.status).toBe(400);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("a file removed while it streams is not saved", async () => {
		const uploads = createUploads(rules());
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (sent++ === 1) await gate;
				if (sent > 3) controller.close();
				else controller.enqueue(new Uint8Array(1024));
			},
		});
		const pending = uploads.receive(post(body, "gone.bin"));
		await Bun.sleep(20);
		uploads.discard();
		release();
		expect((await pending).status).toBe(410);
		expect(readdirSync(dir)).toEqual([]);
	});
});
