/**
 * What a video render stages into its temp directory, and the versions it
 * installs.
 *
 * The Remotion-facing files live in `src/remotion/` as real JavaScript files —
 * linted and formatted like everything else, though not typechecked — but are embedded here as text and never
 * imported, so Remotion never becomes a dependency of this repo and its licence
 * obligation stays with whoever runs `infer render video`. See `docs/adrs/0013`.
 *
 * Nothing user-supplied is interpolated into any of them: dimensions and props
 * arrive through `config.json`, paths and options through argv.
 */

import { basename, dirname, extname, join } from "node:path";
// Text imports: Bun inlines the characters and never follows the imports
// inside, which is what keeps Remotion out of this repo. Being text for the
// whole build, these files must never be imported normally.
// @ts-expect-error text import: Bun inlines the file contents as a string
import indexSource from "./remotion/index.js" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import rootSource from "./remotion/Root.jsx" with { type: "text" };
// @ts-expect-error text import: Bun inlines the file contents as a string
import workerSource from "./remotion/worker.js" with { type: "text" };

export const ROOT_SOURCE: string = rootSource;
export const INDEX_SOURCE: string = indexSource;
export const WORKER_SOURCE: string = workerSource;

/**
 * The Remotion every video render uses.
 *
 * Pinned, and applied to every `@remotion/*` package — including any the
 * composition imports — because Remotion refuses to run with mixed versions
 * and ships two or three releases a week. Unpinned, a render could change, or
 * break, between two runs with nothing changed here.
 */
export const REMOTION_VERSION = "4.0.532";

/** The React that Remotion release is tested against. */
export const REACT_VERSION = "19.2.3";

const CORE_PACKAGES = [
	"remotion",
	"@remotion/bundler",
	"@remotion/renderer",
	"react",
	"react-dom",
] as const;

const pin = (name: string): string =>
	name === "remotion" || name.startsWith("@remotion/")
		? `${name}@${REMOTION_VERSION}`
		: name === "react" || name === "react-dom"
			? `${name}@${REACT_VERSION}`
			: name;

/**
 * Everything to install for a render: the core packages plus whatever the
 * composition imports, with Remotion and React pinned wherever they appear.
 */
export const videoDeps = (
	imports: ReadonlyArray<string>,
): ReadonlyArray<string> => [
	...new Set([...CORE_PACKAGES, ...imports].map(pin)),
];

/** Chrome's OpenGL backends, as Remotion names them. */
export const GL_RENDERERS = [
	"angle",
	"angle-egl",
	"egl",
	"swangle",
	"swiftshader",
	"vulkan",
] as const;

/**
 * Parses `--frame`: one frame, or several separated by commas.
 *
 * Returns the frames in the order given without duplicates, or a message
 * saying what is wrong.
 */
export const parseFrames = (raw: string): ReadonlyArray<number> | string => {
	const parts = raw.split(",").map((part) => part.trim());
	if (parts.some((part) => !/^\d+$/.test(part))) {
		return `--frame takes frame numbers separated by commas, like 0,45,90; got "${raw}".`;
	}
	return [...new Set(parts.map(Number))];
};

/**
 * Where each still goes. One frame writes to the output path as given; several
 * write beside it, numbered by frame: `check.png` becomes `check-0.png`,
 * `check-45.png`.
 */
export const stillPaths = (
	output: string,
	frames: ReadonlyArray<number>,
): ReadonlyArray<{ readonly frame: number; readonly outputPath: string }> => {
	if (frames.length === 1) {
		return [{ frame: frames[0] as number, outputPath: output }];
	}
	const ext = extname(output);
	const stem = basename(output, ext);
	return frames.map((frame) => ({
		frame,
		outputPath: join(dirname(output), `${stem}-${frame}${ext}`),
	}));
};

/** Minimal manifest so `bun install` has somewhere to record dependencies. */
export const PACKAGE_JSON_SOURCE = JSON.stringify(
	{ name: "infer-render", private: true, type: "module" },
	null,
	2,
);

/** Compilers need JSX settings; the staged project has no tsconfig otherwise. */
export const TSCONFIG_SOURCE = JSON.stringify(
	{
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			jsx: "react-jsx",
			strict: false,
			skipLibCheck: true,
			resolveJsonModule: true,
			esModuleInterop: true,
		},
	},
	null,
	2,
);

export const CODECS = [
	"h264",
	"h265",
	"vp8",
	"vp9",
	"prores",
	"gif",
	"mp3",
	"aac",
	"wav",
] as const;
