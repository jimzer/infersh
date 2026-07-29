import { describe, expect, test } from "bun:test";
import {
	exceedsAttachmentLimit,
	ffmpegArgs,
	formatBytes,
	isSupportedExtension,
	MAX_ATTACHMENT_BYTES,
	type TranscribeOptions,
	validate,
} from "./groq.ts";

const options = (over: Partial<TranscribeOptions> = {}): TranscribeOptions => ({
	model: "whisper-large-v3-turbo",
	granularities: [],
	optimize: true,
	...over,
});

describe("validate", () => {
	test("accepts a file on its own", () => {
		expect(validate(options({ file: "a.mp3" }))).toBeNull();
	});

	test("accepts a url on its own", () => {
		expect(validate(options({ url: "https://x/a.mp3" }))).toBeNull();
	});

	test("requires one source", () => {
		expect(validate(options())).toBe("Either --file or --url is required.");
	});

	test("rejects both sources at once", () => {
		expect(validate(options({ file: "a.mp3", url: "https://x/a.mp3" }))).toBe(
			"Pass either --file or --url, not both.",
		);
	});

	test("treats an empty string as absent", () => {
		expect(validate(options({ file: "" }))).toBe(
			"Either --file or --url is required.",
		);
	});

	test("granularities need verbose_json", () => {
		expect(
			validate(options({ file: "a.mp3", granularities: ["word"] })),
		).toContain("verbose_json");
		expect(
			validate(
				options({
					file: "a.mp3",
					granularities: ["word"],
					responseFormat: "json",
				}),
			),
		).toContain("verbose_json");
	});

	test("granularities are fine with verbose_json", () => {
		expect(
			validate(
				options({
					file: "a.mp3",
					granularities: ["word", "segment"],
					responseFormat: "verbose_json",
				}),
			),
		).toBeNull();
	});

	test("temperature must be within 0 and 1", () => {
		expect(validate(options({ file: "a.mp3", temperature: 1.5 }))).toContain(
			"between 0 and 1",
		);
		expect(validate(options({ file: "a.mp3", temperature: -0.1 }))).toContain(
			"between 0 and 1",
		);
		expect(validate(options({ file: "a.mp3", temperature: 0 }))).toBeNull();
		expect(validate(options({ file: "a.mp3", temperature: 1 }))).toBeNull();
	});
});

describe("ffmpegArgs", () => {
	test("matches the preprocessing Groq documents", () => {
		expect(ffmpegArgs("in.m4a", "out.flac")).toEqual([
			"ffmpeg",
			"-i",
			"in.m4a",
			"-ar",
			"16000",
			"-ac",
			"1",
			"-map",
			"0:a",
			"-c:a",
			"flac",
			"-y",
			"out.flac",
		]);
	});

	test("passes paths as separate argv entries, so spaces need no quoting", () => {
		const args = ffmpegArgs("/my files/a b.m4a", "/tmp/o.flac");
		expect(args).toContain("/my files/a b.m4a");
	});
});

describe("exceedsAttachmentLimit", () => {
	test("allows anything up to the limit", () => {
		expect(exceedsAttachmentLimit(MAX_ATTACHMENT_BYTES)).toBe(false);
		expect(exceedsAttachmentLimit(0)).toBe(false);
	});

	test("rejects a byte over", () => {
		expect(exceedsAttachmentLimit(MAX_ATTACHMENT_BYTES + 1)).toBe(true);
	});
});

describe("formatBytes", () => {
	test("scales the unit", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(26 * 1024 * 1024)).toBe("26.0 MB");
	});
});

describe("isSupportedExtension", () => {
	test("accepts the documented formats regardless of case", () => {
		expect(isSupportedExtension("a.mp3")).toBe(true);
		expect(isSupportedExtension("a.FLAC")).toBe(true);
		expect(isSupportedExtension("/path/to/a.m4a")).toBe(true);
	});

	test("rejects anything else", () => {
		expect(isSupportedExtension("a.aiff")).toBe(false);
		expect(isSupportedExtension("a")).toBe(false);
	});
});
