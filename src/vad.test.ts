import { describe, expect, test } from "bun:test";
import {
	frameLevels,
	SAMPLE_RATE,
	speechRegions,
	splice,
	toOriginal,
} from "./vad.ts";

/** Seconds of a 200 Hz tone at `amplitude`, or of faint noise when 0. */
const audio = (
	parts: ReadonlyArray<{ seconds: number; amplitude: number }>,
): Int16Array => {
	const samples: Array<number> = [];
	for (const part of parts) {
		for (let i = 0; i < part.seconds * SAMPLE_RATE; i++) {
			const noise = (Math.random() - 0.5) * 20;
			samples.push(
				Math.round(
					part.amplitude * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) +
						noise,
				),
			);
		}
	}
	return Int16Array.from(samples);
};

describe("speechRegions", () => {
	test("finds speech above the track's own noise floor, padded", () => {
		const track = audio([
			{ seconds: 10, amplitude: 0 },
			{ seconds: 3, amplitude: 8000 },
			{ seconds: 20, amplitude: 0 },
			{ seconds: 2, amplitude: 8000 },
			{ seconds: 5, amplitude: 0 },
		]);
		const regions = speechRegions(frameLevels(track));
		expect(regions).toHaveLength(2);
		expect(regions[0]?.start).toBeCloseTo(9.7, 1);
		expect(regions[0]?.end).toBeCloseTo(13.3, 1);
		expect(regions[1]?.start).toBeCloseTo(32.7, 1);
	});

	test("bridges short pauses and drops clicks", () => {
		const track = audio([
			{ seconds: 5, amplitude: 0 },
			{ seconds: 1, amplitude: 8000 },
			{ seconds: 0.3, amplitude: 0 },
			{ seconds: 1, amplitude: 8000 },
			{ seconds: 5, amplitude: 0 },
			{ seconds: 0.06, amplitude: 8000 },
			{ seconds: 5, amplitude: 0 },
		]);
		expect(speechRegions(frameLevels(track))).toHaveLength(1);
	});

	test("finds nothing in a silent track", () => {
		expect(
			speechRegions(frameLevels(audio([{ seconds: 30, amplitude: 0 }]))),
		).toEqual([]);
	});
});

describe("splice and toOriginal", () => {
	test("maps times in the cut audio back to the original clock", () => {
		const track = audio([{ seconds: 60, amplitude: 0 }]);
		const { audio: cut, map } = splice(track, [
			{ start: 10, end: 12 },
			{ start: 40, end: 45 },
		]);
		// 2 s + 0.3 s gap + 5 s.
		expect(cut.length / SAMPLE_RATE).toBeCloseTo(7.3, 3);
		expect(toOriginal(0, map)).toBeCloseTo(10, 3);
		expect(toOriginal(1.5, map)).toBeCloseTo(11.5, 3);
		// In the gap: the end of the region before it.
		expect(toOriginal(2.1, map)).toBeCloseTo(12, 3);
		expect(toOriginal(2.3, map)).toBeCloseTo(40, 3);
		expect(toOriginal(6, map)).toBeCloseTo(43.7, 3);
	});
});
