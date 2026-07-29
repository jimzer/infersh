/**
 * Sources staged into the temp directory for a video render.
 *
 * These are plain string constants rather than real files in `src/`, because
 * they import Remotion — keeping them as data means Remotion never becomes a
 * dependency of this repo, and its licence obligation stays with the person
 * who chooses to run `infer render video`. See `docs/adrs/0013`.
 *
 * Nothing user-supplied is interpolated into any of them: dimensions and props
 * arrive through `config.json`, paths and options through argv.
 */

/**
 * Registers the composition.
 *
 * Configuration is merged rather than baked in: built-in defaults, then a
 * `config` export on the composition, then whatever flags were passed. Only
 * explicitly-set flags reach `config.json`, so a flag always wins and an
 * absent flag never overrides the composition's own choice.
 */
export const ROOT_SOURCE = `import { Composition } from "remotion";
import Component, * as compositionModule from "./composition";
import overrides from "./config.json";

const DEFAULTS = { width: 1920, height: 1080, fps: 30, durationInFrames: 150 };

const fromComposition =
	(compositionModule as { config?: Record<string, number> }).config ??
	(Component as unknown as { config?: Record<string, number> }).config ??
	{};

const resolved = { ...DEFAULTS, ...fromComposition, ...overrides.dimensions };

export const Root: React.FC = () => (
	<Composition
		id="main"
		component={Component as React.FC}
		width={resolved.width}
		height={resolved.height}
		fps={resolved.fps}
		durationInFrames={resolved.durationInFrames}
		defaultProps={overrides.props}
	/>
);
`;

export const INDEX_SOURCE = `import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
`;

/**
 * The worker. Bundles the staged project with Rspack, selects the composition
 * and renders it, reporting progress on stderr so stdout stays the output path.
 */
export const VIDEO_CHILD_SOURCE = `import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const job = JSON.parse(process.argv[2] ?? "{}");

const write = (line) => process.stderr.write(line + "\\n");

let lastBundlePercent = -1;
const serveUrl = await bundle({
	entryPoint: job.entryPoint,
	// Rspack is Remotion's intended default going forward and is a public
	// option, not an internal one.
	rspack: true,
	// Assets are served from wherever they already live. Symlinking avoids
	// copying a potentially large folder into the temp directory.
	publicDir: job.publicDir ?? null,
	symlinkPublicDir: true,
	onProgress: (percent) => {
		const rounded = Math.floor(percent / 10) * 10;
		if (rounded > lastBundlePercent) {
			lastBundlePercent = rounded;
			write("bundling " + rounded + "%");
		}
	},
});

const composition = await selectComposition({
	serveUrl,
	id: "main",
	inputProps: job.props ?? {},
});

write(
	"composition " +
		composition.width +
		"x" +
		composition.height +
		" " +
		composition.fps +
		"fps " +
		composition.durationInFrames +
		" frames",
);

// A single frame skips encoding entirely — the fast way to check a
// composition looks right before paying for the whole render.
if (job.frame !== undefined) {
	write("rendering frame " + job.frame);
	await renderStill({
		composition,
		serveUrl,
		output: job.outputPath,
		frame: job.frame,
		inputProps: job.props ?? {},
		imageFormat: job.stillFormat ?? "png",
		...(job.scale !== undefined ? { scale: job.scale } : {}),
		chromiumOptions: { gl: "angle" },
	});
	process.exit(0);
}

let lastRenderPercent = -1;
await renderMedia({
	composition,
	serveUrl,
	codec: job.codec ?? "h264",
	outputLocation: job.outputPath,
	inputProps: job.props ?? {},
	...(job.concurrency ? { concurrency: job.concurrency } : {}),
	...(job.crf !== undefined ? { crf: job.crf } : {}),
	...(job.scale !== undefined ? { scale: job.scale } : {}),
	...(job.frameRange ? { frameRange: job.frameRange } : {}),
	...(job.muted ? { muted: true } : {}),
	chromiumOptions: { gl: "angle" },
	onProgress: ({ progress }) => {
		const rounded = Math.floor(progress * 100 / 5) * 5;
		if (rounded > lastRenderPercent) {
			lastRenderPercent = rounded;
			write("rendering " + rounded + "%");
		}
	},
});
`;

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

/** Packages every video render needs, whatever the composition imports. */
export const VIDEO_CORE_DEPS = [
	"remotion",
	"@remotion/bundler",
	"@remotion/renderer",
	"react",
	"react-dom",
];

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
