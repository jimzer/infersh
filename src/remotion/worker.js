/**
 * The video render worker.
 *
 * Runs as a separate `bun run` inside the render's temp directory, against the
 * Remotion packages installed there. Bundles the staged project with Rspack,
 * selects the composition and renders it — a video, or one still per
 * requested frame — reporting progress on stderr so stdout stays clean.
 *
 * Never imported by the CLI: embedded as text and written beside `index.ts`.
 * It imports Remotion, which is deliberately not a dependency of this repo
 * (ADR 13), so it is JavaScript: linted, but not typechecked here.
 */

import { bundle } from "@remotion/bundler";
import {
	openBrowser,
	renderMedia,
	renderStill,
	selectComposition,
} from "@remotion/renderer";

const job = JSON.parse(process.argv[2] ?? "{}");

const write = (line) => process.stderr.write(`${line}\n`);

// Unset means Remotion's own default. Hardcoding `angle` broke machines with
// no GPU, where Remotion's docs recommend `swangle`.
const chromiumOptions = job.gl ? { gl: job.gl } : {};

let lastBundlePercent = -1;
const serveUrl = await bundle({
	entryPoint: job.entryPoint,
	// Rspack is Remotion's intended default going forward, and a public option.
	rspack: true,
	// Assets are served from wherever they already live, never copied.
	publicDir: job.publicDir ?? null,
	symlinkPublicDir: true,
	onProgress: (percent) => {
		const rounded = Math.floor(percent / 10) * 10;
		if (rounded > lastBundlePercent) {
			lastBundlePercent = rounded;
			write(`bundling ${rounded}%`);
		}
	},
});

// One browser for selecting the composition and every frame, rather than a
// launch per call.
const browser = await openBrowser("chrome", { chromiumOptions });

try {
	const composition = await selectComposition({
		serveUrl,
		id: "main",
		inputProps: job.props ?? {},
		puppeteerInstance: browser,
	});

	write(
		`composition ${composition.width}x${composition.height} ${composition.fps}fps ${composition.durationInFrames} frames`,
	);

	const pastEnd = (job.stills ?? []).filter(
		(still) => still.frame >= composition.durationInFrames,
	);
	if (pastEnd.length > 0) {
		// Checked before rendering anything, and reported as a message rather
		// than a stack trace: it is a usage error, not a crash.
		write(
			`Frame ${pastEnd.map((still) => still.frame).join(", ")} is past the end: the composition has ${composition.durationInFrames} frames (0-${composition.durationInFrames - 1}).`,
		);
		process.exitCode = 1;
	} else if (job.stills) {
		// Stills skip encoding entirely: the fast way to check a composition,
		// and several of them share the bundle and the browser.
		for (const still of job.stills) {
			write(`rendering frame ${still.frame}`);
			await renderStill({
				composition,
				serveUrl,
				output: still.outputPath,
				frame: still.frame,
				inputProps: job.props ?? {},
				imageFormat: job.stillFormat ?? "png",
				...(job.scale !== undefined ? { scale: job.scale } : {}),
				puppeteerInstance: browser,
			});
		}
	} else {
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
			chromiumOptions,
			puppeteerInstance: browser,
			onProgress: ({ progress }) => {
				const rounded = Math.floor((progress * 100) / 5) * 5;
				if (rounded > lastRenderPercent) {
					lastRenderPercent = rounded;
					write(`rendering ${rounded}%`);
				}
			},
		});
	}
} finally {
	await browser.close({ silent: true });
}
