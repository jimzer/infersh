import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters as plain } from "node:util";
import { mergeTracks, meterLine } from "./meeting.ts";

describe("meterLine", () => {
	test("shows elapsed time and a bar per track", () => {
		const line = plain(
			meterLine(
				65_000,
				[
					{ label: "Me", decibels: 0, silentMs: 0 },
					{ label: "Them", decibels: -60, silentMs: 0 },
				],
				80,
			),
		);
		expect(line).toBe(`● 01:05  Me ${"█".repeat(16)}  Them ${"·".repeat(16)}`);
	});

	test("calls out a track silent for 30 s or more", () => {
		const line = plain(
			meterLine(
				90_000,
				[{ label: "Them", decibels: -60, silentMs: 45_000 }],
				60,
			),
		);
		expect(line).toContain("Them ········ silent 00:45");
	});
});

describe("mergeTracks", () => {
	test("drops mic echoes of the other side, even when split differently", () => {
		const turns = mergeTracks([
			{
				speaker: "Them",
				offset: 0,
				segments: [
					{ start: 0, end: 2, text: "Hi Jimi, thanks for joining." },
					{ start: 2, end: 5, text: "We ship version eleven today." },
				],
			},
			{
				speaker: "Me",
				offset: 0.1,
				echoOf: "Them",
				segments: [
					{
						start: 0,
						end: 5,
						text: "Hi Jimi, thanks for joining. We ship version eleven today.",
					},
					{ start: 7, end: 9, text: "Great, I will send the notes." },
				],
			},
		]);
		expect(turns.map((turn) => turn.speaker)).toEqual(["Them", "Me"]);
		expect(turns[1]?.text).toBe("Great, I will send the notes.");
	});

	test("drops what Whisper marks as probably silence", () => {
		const turns = mergeTracks([
			{
				speaker: "Me",
				offset: 0,
				segments: [
					{ start: 0, end: 1, text: "Thank you.", no_speech_prob: 0.9 },
				],
			},
		]);
		expect(turns).toEqual([]);
	});
});
