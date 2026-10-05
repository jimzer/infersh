import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addSpan,
	contentDisposition,
	covers,
	createDownloads,
	type OfferedFile,
	parseRange,
	previewable,
} from "./ui-download.ts";

describe("contentDisposition", () => {
	test("gives an ASCII name as it is, in both forms", () => {
		expect(contentDisposition("attachment", "report.pdf")).toBe(
			`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		);
	});

	test("keeps the exact name in filename*, and an ASCII cousin in filename", () => {
		expect(contentDisposition("attachment", "résumé été.txt")).toBe(
			`attachment; filename="resume ete.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%C3%A9t%C3%A9.txt`,
		);
		expect(contentDisposition("inline", "写真 ☕.jpg")).toBe(
			`inline; filename="__ _.jpg"; filename*=UTF-8''%E5%86%99%E7%9C%9F%20%E2%98%95.jpg`,
		);
	});

	test("escapes what RFC 5987 does not allow, which encodeURIComponent keeps", () => {
		expect(contentDisposition("attachment", "it's (1)*.txt")).toBe(
			`attachment; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A.txt`,
		);
	});

	test("cannot break out of the quotes or the header", () => {
		const header = contentDisposition("attachment", 'a"b\\c\r\nSet-Cookie: x');
		expect(header).toStartWith(`attachment; filename="a_b_c__Set-Cookie: x";`);
		expect(header).not.toMatch(/[\r\n]/);
	});
});

describe("parseRange", () => {
	const size = 1000;

	test("sends the whole file when nothing is asked", () => {
		expect(parseRange(null, size)).toEqual({ kind: "full" });
	});

	test("reads a closed range, an open one and a suffix", () => {
		expect(parseRange("bytes=0-99", size)).toEqual({
			kind: "partial",
			start: 0,
			end: 99,
		});
		expect(parseRange("bytes=900-", size)).toEqual({
			kind: "partial",
			start: 900,
			end: 999,
		});
		expect(parseRange("bytes=-100", size)).toEqual({
			kind: "partial",
			start: 900,
			end: 999,
		});
	});

	test("clamps an end past the file, and a suffix longer than it", () => {
		expect(parseRange("bytes=500-5000", size)).toEqual({
			kind: "partial",
			start: 500,
			end: 999,
		});
		expect(parseRange("bytes=-5000", size)).toEqual({
			kind: "partial",
			start: 0,
			end: 999,
		});
	});

	test("cannot meet a range that starts past the end: 416", () => {
		expect(parseRange("bytes=1000-", size)).toEqual({ kind: "unsatisfiable" });
		expect(parseRange("bytes=5000-6000", size)).toEqual({
			kind: "unsatisfiable",
		});
		expect(parseRange("bytes=-0", size)).toEqual({ kind: "unsatisfiable" });
		expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
		expect(parseRange("bytes=-10", 0)).toEqual({ kind: "unsatisfiable" });
	});

	test("ignores what it cannot read, and sends the whole file", () => {
		for (const header of [
			"bytes=",
			"bytes=-",
			"bytes=abc-",
			"bytes=5-1",
			"items=0-10",
			"bytes=0-10,20-30",
			"bytes=1e3-",
			"bytes=-1-2",
		]) {
			expect(parseRange(header, size)).toEqual({ kind: "full" });
		}
	});

	test("tolerates spaces and case", () => {
		expect(parseRange(" Bytes = 1 - 2 ", size)).toEqual({
			kind: "partial",
			start: 1,
			end: 2,
		});
	});
});

describe("spans", () => {
	test("merge as they touch or overlap, in any order", () => {
		let spans = addSpan([], 200, 300);
		spans = addSpan(spans, 0, 100);
		expect(spans).toEqual([
			[0, 100],
			[200, 300],
		]);
		spans = addSpan(spans, 100, 200);
		expect(spans).toEqual([[0, 300]]);
		expect(addSpan([[0, 50]], 10, 20)).toEqual([[0, 50]]);
		expect(addSpan([[0, 50]], 60, 60)).toEqual([[0, 50]]);
	});

	test("cover a file only when every byte was sent", () => {
		expect(covers([[0, 999]], 1000)).toBe(false);
		expect(
			covers(
				[
					[0, 500],
					[501, 1000],
				],
				1000,
			),
		).toBe(false);
		expect(covers([[0, 1000]], 1000)).toBe(true);
		expect(covers([], 0)).toBe(true);
	});
});

describe("previewable", () => {
	test("is images, video, audio and PDFs", () => {
		for (const type of ["image/png", "video/mp4", "audio/mpeg"]) {
			expect(previewable(type)).toBe(true);
		}
		expect(previewable("application/pdf")).toBe(true);
		expect(previewable("text/html")).toBe(false);
		expect(previewable("application/zip")).toBe(false);
	});
});

// --- serving ----------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "infer-download-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const offer = (
	name: string,
	content: Uint8Array,
	type: string,
): OfferedFile => {
	const path = join(dir, name);
	writeFileSync(path, content);
	return { path, name, size: content.length, type };
};

const video = crypto.getRandomValues(new Uint8Array(300_000));
const notes = new TextEncoder().encode("été\n".repeat(100));
const files = [
	offer("clip.mp4", video, "video/mp4"),
	offer("notes été.txt", notes, "text/plain"),
];

const fresh = () => createDownloads({ files, zipName: "files.zip" });

const get = (path: string, headers: Record<string, string> = {}) =>
	new Request(`http://127.0.0.1${path}`, { headers });

const bytesOf = async (response: Response) =>
	new Uint8Array(await response.arrayBuffer());

describe("createDownloads", () => {
	test("serves a whole file for download, and counts it", async () => {
		const downloads = fresh();
		const response = downloads.file(get("/api/file/0?download=1"), "0");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-length")).toBe(String(video.length));
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(response.headers.get("content-disposition")).toStartWith(
			"attachment;",
		);
		expect(await bytesOf(response)).toEqual(video);
		expect(downloads.downloaded()).toEqual([
			{ path: files[0]?.path ?? "", name: "clip.mp4", size: video.length },
		]);
		expect(downloads.progress()).toEqual({ downloaded: [0], active: 0 });
	});

	test("serves a range as 206, and a preview inline, neither counted", async () => {
		const downloads = fresh();
		const partial = downloads.file(
			get("/api/file/0", { range: "bytes=100-199" }),
			"0",
		);
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-range")).toBe(
			`bytes 100-199/${video.length}`,
		);
		expect(partial.headers.get("content-disposition")).toStartWith("inline;");
		expect(await bytesOf(partial)).toEqual(video.subarray(100, 200));
		// A preview that happens to read the whole file is still a preview.
		await bytesOf(downloads.file(get("/api/file/0"), "0"));
		expect(downloads.downloaded()).toEqual([]);
	});

	test("counts a download resumed across ranges once every byte went", async () => {
		const downloads = fresh();
		const first = downloads.file(
			get("/api/file/0?download=1", { range: "bytes=0-149999" }),
			"0",
		);
		await bytesOf(first);
		expect(downloads.downloaded()).toEqual([]);
		const rest = downloads.file(
			get("/api/file/0?download=1", { range: "bytes=150000-" }),
			"0",
		);
		expect(await bytesOf(rest)).toEqual(video.subarray(150_000));
		expect(downloads.progress().downloaded).toEqual([0]);
	});

	test("does not count a download cut off part way", async () => {
		const downloads = fresh();
		const response = downloads.file(get("/api/file/0?download=1"), "0");
		const reader = response.body?.getReader();
		await reader?.read();
		expect(downloads.progress().active).toBe(1);
		const idle = downloads.idle();
		await reader?.cancel();
		await idle;
		expect(downloads.progress()).toEqual({ downloaded: [], active: 0 });
	});

	test("answers 416 past the end, with the size", () => {
		const response = fresh().file(
			get("/api/file/1", { range: `bytes=${notes.length}-` }),
			"1",
		);
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe(
			`bytes */${notes.length}`,
		);
	});

	test("ignores a range for a file that changed since", async () => {
		const response = fresh().file(
			get("/api/file/1", { range: "bytes=0-9", "if-range": '"stale"' }),
			"1",
		);
		expect(response.status).toBe(200);
		expect(await bytesOf(response)).toEqual(notes);
	});

	test("answers HEAD with the headers alone", async () => {
		const response = fresh().file(
			new Request("http://127.0.0.1/api/file/1", { method: "HEAD" }),
			"1",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-length")).toBe(String(notes.length));
		expect((await bytesOf(response)).length).toBe(0);
	});

	test("never serves a script-capable type in the page's origin", () => {
		const response = fresh().file(get("/api/file/1"), "1");
		expect(response.headers.get("content-security-policy")).toBe("sandbox");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		// Not previewable, so attachment even when not asked.
		expect(response.headers.get("content-disposition")).toStartWith(
			"attachment;",
		);
	});

	test("finds nothing by anything but a position in the list", () => {
		const downloads = fresh();
		for (const index of ["2", "-1", "1.0", "1e0", "../etc/passwd", "", " 1"]) {
			expect(downloads.file(get("/api/file/x"), index).status).toBe(404);
		}
		expect(
			downloads.file(
				new Request("http://127.0.0.1/api/file/0", { method: "POST" }),
				"0",
			).status,
		).toBe(405);
	});

	test("streams Download all, and counts every file once it is whole", async () => {
		const downloads = fresh();
		const response = downloads.zip(get("/api/zip"));
		expect(response.headers.get("content-type")).toBe("application/zip");
		expect(response.headers.get("content-disposition")).toContain("files.zip");
		const bytes = await bytesOf(response);
		expect(bytes.length).toBe(Number(response.headers.get("content-length")));
		const path = join(dir, "all.zip");
		writeFileSync(path, bytes);
		expect(Bun.spawnSync(["unzip", "-t", path]).exitCode).toBe(0);
		expect(downloads.progress()).toEqual({ downloaded: [0, 1], active: 0 });
	});

	test("counts nothing for a Download all cut off part way", async () => {
		const downloads = fresh();
		const reader = downloads.zip(get("/api/zip")).body?.getReader();
		await reader?.read();
		await reader?.read();
		await reader?.cancel();
		expect(downloads.progress()).toEqual({ downloaded: [], active: 0 });
	});

	test("says so when a file left the disk after the command started", () => {
		const gone = offer("gone.txt", notes, "text/plain");
		rmSync(gone.path);
		const downloads = createDownloads({ files: [gone], zipName: "x.zip" });
		expect(downloads.file(get("/api/file/0"), "0").status).toBe(410);
		expect(downloads.zip(get("/api/zip")).status).toBe(410);
	});
});
