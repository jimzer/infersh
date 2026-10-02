import { describe, expect, test } from "bun:test";
import {
	audioArgs,
	audioExtension,
	canCopyAudio,
	defaultOutput,
	escapeDrawtext,
	evenSizeFilter,
	formatClock,
	gifEncodeArgs,
	gifPaletteArgs,
	gridFor,
	parseProbe,
	parseRate,
	parseTime,
	sampleTimes,
	stillArgs,
	tail,
	transcriptionArgs,
	trimArgs,
	webArgs,
} from "./media.ts";

/** ffprobe's JSON for a 641x361 H.264 + stereo AAC clip, trimmed to what matters. */
const PROBE = JSON.stringify({
	streams: [
		{
			index: 0,
			codec_name: "h264",
			codec_type: "video",
			width: 641,
			height: 361,
			pix_fmt: "yuv444p",
			r_frame_rate: "30/1",
			avg_frame_rate: "30/1",
			duration: "6.000000",
			bit_rate: "785294",
			nb_frames: "180",
			disposition: { default: 1, attached_pic: 0 },
		},
		{
			index: 1,
			codec_name: "aac",
			codec_type: "audio",
			sample_rate: "44100",
			channels: 2,
			channel_layout: "stereo",
			r_frame_rate: "0/0",
			avg_frame_rate: "0/0",
			duration: "6.000000",
		},
	],
	format: {
		filename: "src.mov",
		format_name: "mov,mp4,m4a,3gp,3g2,mj2",
		duration: "6.000000",
		size: "693416",
		bit_rate: "924554",
	},
});

describe("parseProbe", () => {
	test("summarises ffprobe's JSON with numbers as numbers", () => {
		expect(parseProbe("src.mov", PROBE)).toEqual({
			file: "src.mov",
			format: "mov,mp4,m4a,3gp,3g2,mj2",
			duration: 6,
			size: 693416,
			bitrate: 924554,
			video: {
				codec: "h264",
				width: 641,
				height: 361,
				fps: 30,
				pixelFormat: "yuv444p",
				frames: 180,
			},
			audio: { codec: "aac", channels: 2, layout: "stereo", sampleRate: 44100 },
			streams: { video: 1, audio: 1, subtitle: 0 },
		});
	});

	test("a phone video's rotation swaps the displayed sides", () => {
		const rotated = JSON.stringify({
			streams: [
				{
					index: 0,
					codec_type: "video",
					codec_name: "hevc",
					width: 1920,
					height: 1080,
					side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
				},
			],
			format: {},
		});
		expect(parseProbe("p.mov", rotated)?.video).toMatchObject({
			width: 1080,
			height: 1920,
			rotation: 270,
		});
	});

	test("cover art is not a video stream", () => {
		const mp3 = JSON.stringify({
			streams: [
				{ index: 0, codec_type: "audio", codec_name: "mp3", channels: 2 },
				{
					index: 1,
					codec_type: "video",
					codec_name: "mjpeg",
					width: 500,
					height: 500,
					disposition: { attached_pic: 1 },
				},
			],
			format: { duration: "180.5" },
		});
		const info = parseProbe("song.mp3", mp3);
		expect(info?.video).toBeUndefined();
		expect(info?.streams.video).toBe(0);
	});

	test("N/A drops that field, not the probe", () => {
		const raw = JSON.stringify({
			streams: [
				{
					index: 0,
					codec_type: "audio",
					codec_name: "pcm_s16le",
					duration: "N/A",
				},
			],
			format: { duration: "N/A", size: "1000" },
		});
		expect(parseProbe("a.wav", raw)).toEqual({
			file: "a.wav",
			size: 1000,
			audio: { codec: "pcm_s16le" },
			streams: { video: 0, audio: 1, subtitle: 0 },
		});
	});

	test("what ffprobe prints for a file it cannot read is not a probe", () => {
		expect(parseProbe("x", "{\n\n}")).toBeNull();
		expect(parseProbe("x", "not json")).toBeNull();
	});
});

describe("parseRate", () => {
	test("NTSC rates round to three places; 0/0 means unknown", () => {
		expect(parseRate("30000/1001")).toBe(29.97);
		expect(parseRate("25/1")).toBe(25);
		expect(parseRate("0/0")).toBeUndefined();
		expect(parseRate(undefined)).toBeUndefined();
	});
});

describe("parseTime", () => {
	test("seconds, a trailing s, and clock forms", () => {
		expect(parseTime("12")).toBe(12);
		expect(parseTime("12.5s")).toBe(12.5);
		expect(parseTime("1:02")).toBe(62);
		expect(parseTime("01:02:03.25")).toBe(3723.25);
	});

	test("rejects what is not a time", () => {
		expect(parseTime("")).toBeNull();
		expect(parseTime("-3")).toBeNull();
		expect(parseTime("1:2:3:4")).toBeNull();
		expect(parseTime("abc")).toBeNull();
	});
});

describe("formatClock", () => {
	test("minutes, then hours when needed, to a tenth", () => {
		expect(formatClock(0.25)).toBe("0:00.2");
		expect(formatClock(75.25)).toBe("1:15.2");
		expect(formatClock(3723.5)).toBe("1:02:03.5");
	});
});

describe("evenSizeFilter", () => {
	test("even sides need nothing", () => {
		expect(evenSizeFilter(1280, 720)).toEqual({ width: 1280, height: 720 });
	});

	test("an odd side is cropped by one pixel, not rescaled", () => {
		expect(evenSizeFilter(641, 361)).toEqual({
			filter: "crop=640:360:0:0",
			width: 640,
			height: 360,
		});
	});

	test("scales down to an even max width, keeping the aspect", () => {
		expect(evenSizeFilter(1920, 1080, 1280)).toEqual({
			filter: "scale=1280:720:flags=lanczos",
			width: 1280,
			height: 720,
		});
		expect(evenSizeFilter(641, 361, 321).filter).toBe(
			"scale=320:180:flags=lanczos",
		);
	});

	test("never scales up", () => {
		expect(evenSizeFilter(640, 360, 1920)).toEqual({ width: 640, height: 360 });
	});
});

describe("defaultOutput", () => {
	test("beside the input, tagged", () => {
		expect(defaultOutput("/v/clip.mov", "web", ".mp4")).toBe("/v/clip.web.mp4");
	});

	test("untagged, unless that would be the input itself", () => {
		expect(defaultOutput("/v/clip.mov", null, ".gif")).toBe("/v/clip.gif");
		expect(defaultOutput("/v/song.mp3", null, ".mp3")).toBe("/v/song.out.mp3");
	});
});

const flagValue = (args: ReadonlyArray<string>, flag: string) =>
	args[args.indexOf(flag) + 1];

describe("webArgs", () => {
	const base = {
		input: "in.mov",
		output: "out.mp4",
		width: 641,
		height: 361,
		crf: 23,
		preset: "medium",
		audio: true,
		channels: 2,
	};

	test("H.264 in yuv420p with faststart and even sides", () => {
		const args = webArgs(base);
		expect(flagValue(args, "-c:v")).toBe("libx264");
		expect(flagValue(args, "-pix_fmt")).toBe("yuv420p");
		expect(flagValue(args, "-movflags")).toBe("+faststart");
		expect(flagValue(args, "-vf")).toBe("crop=640:360:0:0");
		expect(flagValue(args, "-c:a")).toBe("aac");
		expect(args).toContain("0:a:0?");
		expect(args).not.toContain("-ac");
		expect(args.at(-1)).toBe("out.mp4");
	});

	test("never waits on stdin and only reports errors", () => {
		const args = webArgs(base);
		expect(args).toContain("-nostdin");
		expect(flagValue(args, "-v")).toBe("error");
	});

	test("5.1 is downmixed to stereo", () => {
		expect(flagValue(webArgs({ ...base, channels: 6 }), "-ac")).toBe("2");
	});

	test("--no-audio drops the track", () => {
		const args = webArgs({ ...base, audio: false });
		expect(args).toContain("-an");
		expect(args).not.toContain("0:a:0?");
	});
});

describe("gif passes", () => {
	const options = {
		input: "in.mov",
		output: "out.gif",
		palette: "/tmp/p.png",
		fps: 15,
		width: 480,
		from: 2,
		to: 5,
	};

	test("both passes see the same frames: same seek, rate and size", () => {
		const one = gifPaletteArgs(options);
		const two = gifEncodeArgs(options);
		expect(flagValue(one, "-ss")).toBe("2");
		expect(flagValue(one, "-t")).toBe("3");
		expect(flagValue(two, "-ss")).toBe("2");
		expect(flagValue(two, "-t")).toBe("3");
		expect(flagValue(one, "-vf")).toStartWith(
			"fps=15,scale=480:-1:flags=lanczos,",
		);
		expect(flagValue(two, "-lavfi")).toStartWith(
			"fps=15,scale=480:-1:flags=lanczos[x]",
		);
	});

	test("pass one makes the palette, pass two uses it", () => {
		expect(flagValue(gifPaletteArgs(options), "-vf")).toContain("palettegen");
		const two = gifEncodeArgs(options);
		expect(two.filter((a) => a === "-i")).toHaveLength(2);
		expect(two).toContain("/tmp/p.png");
		expect(flagValue(two, "-lavfi")).toContain("[x][1:v]paletteuse");
		expect(flagValue(two, "-loop")).toBe("0");
	});
});

describe("trimArgs", () => {
	const base = {
		input: "in.mov",
		output: "out.mp4",
		from: 1.5,
		to: 4,
		copy: false,
		width: 641,
		height: 361,
	};

	test("re-encodes by default, seeking on the input for an exact frame", () => {
		const args = trimArgs(base);
		expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
		expect(flagValue(args, "-ss")).toBe("1.5");
		expect(flagValue(args, "-t")).toBe("2.5");
		expect(flagValue(args, "-c:v")).toBe("libx264");
		expect(flagValue(args, "-crf")).toBe("18");
		expect(flagValue(args, "-vf")).toBe("crop=640:360:0:0");
		expect(args).not.toContain("copy");
	});

	test("--copy copies every stream and zeroes the timestamps", () => {
		const args = trimArgs({ ...base, copy: true });
		expect(flagValue(args, "-c")).toBe("copy");
		expect(flagValue(args, "-avoid_negative_ts")).toBe("make_zero");
		expect(args).not.toContain("libx264");
	});

	test("other containers keep ffmpeg's own codecs for them", () => {
		const args = trimArgs({ ...base, output: "out.mkv" });
		expect(args).not.toContain("libx264");
		expect(args).toContain("0:s?");
	});
});

describe("frames", () => {
	test("samples the middle of equal slices, never the very end", () => {
		expect(sampleTimes(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
	});

	test("the grid fits the count", () => {
		expect(gridFor(12, 4)).toEqual({ columns: 4, rows: 3 });
		expect(gridFor(10, 4)).toEqual({ columns: 4, rows: 3 });
		expect(gridFor(3, 4)).toEqual({ columns: 3, rows: 1 });
	});

	test("a still seeks first and burns its label in", () => {
		const args = stillArgs({
			input: "in.mov",
			output: "001.png",
			time: 62.5,
			width: 320,
			label: "1:02.5",
		});
		expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
		expect(flagValue(args, "-frames:v")).toBe("1");
		expect(flagValue(args, "-vf")).toContain("drawtext=text='1\\:02.5'");
	});

	test("drawtext escaping", () => {
		expect(escapeDrawtext("a:b'c%d\\")).toBe("a\\:b\\'c\\%d\\\\");
	});
});

describe("audio", () => {
	test("copies a codec into a container that holds it as-is", () => {
		expect(canCopyAudio("aac", ".m4a")).toBe(true);
		expect(canCopyAudio("aac", ".mp3")).toBe(false);
		expect(canCopyAudio(undefined, ".m4a")).toBe(false);
		expect(audioExtension("aac")).toBe(".m4a");
		expect(audioExtension("pcm_s16le")).toBe(".wav");
		expect(audioExtension("truehd")).toBe(".m4a");
	});

	test("first track only, copied or re-encoded by the output's extension", () => {
		const copy = audioArgs({ input: "in.mp4", output: "a.m4a", codec: "aac" });
		expect(flagValue(copy, "-map")).toBe("0:a:0");
		expect(flagValue(copy, "-c:a")).toBe("copy");
		const mp3 = audioArgs({ input: "in.mp4", output: "a.mp3", codec: "aac" });
		expect(flagValue(mp3, "-c:a")).toBe("libmp3lame");
	});

	test("for transcription: groq's exact 16 kHz mono FLAC pass, quietly", () => {
		const args = transcriptionArgs("in.mp4", "a.flac");
		expect(flagValue(args, "-ar")).toBe("16000");
		expect(flagValue(args, "-ac")).toBe("1");
		expect(flagValue(args, "-map")).toBe("0:a:0");
		expect(flagValue(args, "-c:a")).toBe("flac");
		expect(args).toContain("-nostdin");
		expect(args.filter((a) => a === "-y")).toHaveLength(1);
		expect(args[0]).not.toBe("ffmpeg");
	});
});

describe("tail", () => {
	test("keeps the last lines, where ffmpeg puts the reason", () => {
		expect(tail("a\nb\nc\nd\ne\nf\ng\n", 2)).toBe("f\ng");
	});
});
