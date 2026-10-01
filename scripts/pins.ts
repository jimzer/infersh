/**
 * `just pins` — every version this CLI pins, against what is published.
 *
 * Some versions are pinned in code rather than in package.json, because they
 * are installed at render time rather than by `bun install` here: Tailwind's
 * browser build, Playwright (which decides the Chrome build), Remotion and the
 * React it is tested against. Nothing updates those on its own, so this lists
 * them beside the latest release, with what to check before bumping each.
 *
 * The pinned values are imported from the code itself, so this can never
 * disagree with what actually ships. Informational: it always exits 0.
 */

import pkg from "../package.json";
import { PLAYWRIGHT_VERSION } from "../src/render.ts";
import { REACT_VERSION, REMOTION_VERSION } from "../src/render-video-source.ts";
import { TAILWIND_NAME, TAILWIND_VERSION } from "../src/tailwind.ts";

interface Pin {
	readonly name: string;
	readonly pinned: string;
	readonly where: string;
	/** What to verify before bumping, because the pin exists for a reason. */
	readonly check: string;
	/** Defaults to npm's `latest` for `name`. */
	readonly latest?: () => Promise<string>;
}

const registry = async (path: string): Promise<Record<string, unknown>> => {
	const response = await fetch(`https://registry.npmjs.org/${path}`, {
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status}`);
	return (await response.json()) as Record<string, unknown>;
};

const latestOf = async (name: string): Promise<string> =>
	String((await registry(`${name}/latest`)).version);

/** The React the newest Remotion is tested against, which REACT_VERSION follows. */
const reactForLatestRemotion = async (): Promise<string> => {
	const remotion = await latestOf("@remotion/renderer");
	const manifest = await registry(`@remotion/renderer/${remotion}`);
	const dev = (manifest.devDependencies ?? {}) as Record<string, string>;
	return dev.react ?? "unknown";
};

const pins: ReadonlyArray<Pin> = [
	{
		name: TAILWIND_NAME,
		pinned: TAILWIND_VERSION,
		where: "src/tailwind.ts TAILWIND_VERSION",
		check:
			"render an image using v4-only classes; re-read the v3/v4 notes in src/skills/references/render.md (ADR 20)",
	},
	{
		name: "playwright-core",
		pinned: PLAYWRIGHT_VERSION,
		where: "src/render.ts PLAYWRIGHT_VERSION + package.json devDependency",
		check:
			"bump both (a test enforces it); the first render then downloads a new ~200 MB headless shell; compare an image render (ADR 22)",
	},
	{
		name: "remotion",
		pinned: REMOTION_VERSION,
		where: "src/render-video-source.ts REMOTION_VERSION",
		check:
			"render --frame 0,45 and a short encode, with a composition importing an @remotion/* package; set REACT_VERSION from the row below (ADR 25)",
	},
	{
		name: "react (for video)",
		pinned: REACT_VERSION,
		where: "src/render-video-source.ts REACT_VERSION",
		check:
			"follows Remotion: use the React that Remotion release is tested against",
		latest: reactForLatestRemotion,
	},
	{
		name: "@types/bun",
		pinned: pkg.devDependencies["@types/bun"],
		where: "package.json devDependency",
		check: "match the Bun that builds releases (CI's setup-bun)",
	},
];

const ranged = Object.entries({
	...pkg.dependencies,
	...pkg.devDependencies,
}).filter(([, range]) => range.startsWith("^"));

const rows = await Promise.all(
	pins.map(async (pin) => {
		const latest = await (pin.latest ?? (() => latestOf(pin.name)))().catch(
			(error: unknown) => `? (${error})`,
		);
		return { ...pin, latest, current: latest === pin.pinned };
	}),
);

const width = Math.max(...rows.map((row) => row.name.length));
console.log("Pinned in code — nothing updates these on its own:\n");
for (const row of rows) {
	const mark = row.current ? "ok    " : "BEHIND";
	console.log(
		`  ${mark}  ${row.name.padEnd(width)}  ${row.pinned.padEnd(10)} latest ${row.latest}`,
	);
	if (!row.current) {
		console.log(`          where: ${row.where}`);
		console.log(`          check: ${row.check}`);
	}
}

const behind = rows.filter((row) => !row.current).length;
console.log(
	`\n${behind === 0 ? "All pins are current." : `${behind} pin${behind === 1 ? "" : "s"} behind.`}`,
);
console.log(
	`\nRanged in package.json (${ranged.map(([name]) => name).join(", ")}) — run \`bun outdated\` for those.`,
);
