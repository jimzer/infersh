import { describe, expect, test } from "bun:test";
import {
	parseFrames,
	REACT_VERSION,
	REMOTION_VERSION,
	stillPaths,
	videoDeps,
} from "./render-video-source.ts";

describe("videoDeps", () => {
	test("pins every Remotion package to one version, imported ones included", () => {
		// Remotion refuses mixed versions, so an unpinned @remotion/transitions
		// next to a pinned remotion would break the render on its next release.
		const deps = videoDeps(["@remotion/transitions", "remotion", "zod"]);
		const remotion = deps.filter(
			(d) => d.startsWith("remotion") || d.startsWith("@remotion/"),
		);
		expect(remotion.length).toBe(4);
		for (const dep of remotion)
			expect(dep.endsWith(`@${REMOTION_VERSION}`)).toBe(true);
	});

	test("pins React to the version Remotion is tested against", () => {
		const deps = videoDeps(["react"]);
		expect(deps).toContain(`react@${REACT_VERSION}`);
		expect(deps).toContain(`react-dom@${REACT_VERSION}`);
		expect(deps.filter((d) => d.startsWith("react@")).length).toBe(1);
	});

	test("leaves the composition's other packages to resolve normally", () => {
		expect(videoDeps(["zod"])).toContain("zod");
	});
});

describe("parseFrames", () => {
	test("reads one frame or a comma-separated list", () => {
		expect(parseFrames("45")).toEqual([45]);
		expect(parseFrames("0, 45,90")).toEqual([0, 45, 90]);
	});

	test("drops duplicates and keeps the order given", () => {
		expect(parseFrames("90,0,90")).toEqual([90, 0]);
	});

	test("explains what is wrong rather than guessing", () => {
		for (const bad of ["", "-1", "1.5", "a", "1,,2"]) {
			expect(typeof parseFrames(bad)).toBe("string");
		}
	});
});

describe("stillPaths", () => {
	test("one frame writes to the output path as given", () => {
		expect(stillPaths("/out/check.png", [45])).toEqual([
			{ frame: 45, outputPath: "/out/check.png" },
		]);
	});

	test("several frames write beside it, numbered by frame", () => {
		expect(stillPaths("/out/check.png", [0, 45])).toEqual([
			{ frame: 0, outputPath: "/out/check-0.png" },
			{ frame: 45, outputPath: "/out/check-45.png" },
		]);
	});
});
