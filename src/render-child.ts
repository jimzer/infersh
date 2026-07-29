/**
 * The render worker.
 *
 * Runs as a separate `bun --install=fallback` process so that React,
 * Playwright and whatever the composition imports are all resolved on demand
 * from Bun's cache — none of them are dependencies of the CLI itself.
 *
 * This file is never imported by the CLI. It is embedded as text and written
 * to a temp directory beside `render-shared.ts`, which is why its only
 * relative import is that one file. See `docs/adrs/0012`.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assetPathFor, buildHtml, formatFromPath } from "./render-shared.ts";

interface Job {
	readonly kind: "image" | "pdf";
	readonly compositionPath: string;
	readonly props: unknown;
	readonly outputPath: string;
	readonly assetDir?: string;
	readonly head?: string;
	readonly tailwind: boolean;
	readonly waitUntil: string;
	readonly transparent?: boolean;
	readonly width?: number;
	readonly height?: number;
	readonly fullPage?: boolean;
	readonly deviceScaleFactor?: number;
	readonly quality?: number;
	readonly paperFormat?: string;
	readonly pageWidth?: string;
	readonly pageHeight?: string;
	readonly margin?: {
		readonly top: string;
		readonly right: string;
		readonly bottom: string;
		readonly left: string;
	};
	readonly landscape?: boolean;
	readonly scale?: number;
}

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

const LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--no-first-run",
];

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const job: Job = JSON.parse(process.argv[2] ?? "{}");

// --- 1. Composition -> markup ---------------------------------------------

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const mod = await import(job.compositionPath);
const Component = mod.default;
if (typeof Component !== "function") {
	fail("The composition must have a default export that is a component.");
}

const markup = renderToStaticMarkup(
	createElement(Component, (job.props ?? {}) as Record<string, unknown>),
);
if (markup.trim() === "") {
	fail(
		"The composition rendered nothing. Does its default export return markup?",
	);
}

const html = buildHtml({
	markup,
	head: job.head,
	tailwind: job.tailwind,
	transparent: job.transparent ?? false,
});

// --- 2. Markup -> browser -------------------------------------------------

const { chromium } = await import("playwright-core");

const launch = async () => {
	const attempts: Array<{ label: string; options: Record<string, unknown> }> =
		[];
	if (process.env.CHROME_PATH) {
		attempts.push({
			label: `CHROME_PATH (${process.env.CHROME_PATH})`,
			options: { executablePath: process.env.CHROME_PATH },
		});
	}
	attempts.push({ label: "system Chrome", options: { channel: "chrome" } });
	for (const path of CHROME_CANDIDATES) {
		attempts.push({ label: path, options: { executablePath: path } });
	}

	for (const attempt of attempts) {
		try {
			return await chromium.launch({
				headless: true,
				args: LAUNCH_ARGS,
				...attempt.options,
			});
		} catch {}
	}
	return fail(
		`No Chrome or Chromium could be launched. Tried: ${attempts
			.map((a) => a.label)
			.join(
				", ",
			)}.\nInstall Google Chrome, or set CHROME_PATH to an executable.`,
	);
};

const browser = await launch();

try {
	const context = await browser.newContext({
		viewport: { width: job.width ?? 1280, height: job.height ?? 720 },
		deviceScaleFactor: job.deviceScaleFactor ?? 1,
	});
	const page = await context.newPage();

	// Local assets are served by intercepting the virtual origin, so no HTTP
	// server is started and the asset directory is read in place.
	await page.route(`${"http://assets.infer.local"}/**`, async (route) => {
		if (job.assetDir === undefined) {
			return route.fulfill({
				status: 404,
				body: "no --assets directory given",
			});
		}
		const path = assetPathFor(route.request().url(), job.assetDir);
		if (path === null) {
			return route.fulfill({
				status: 403,
				body: "outside the asset directory",
			});
		}
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return route.fulfill({ status: 404, body: "not found" });
		}
		return route.fulfill({
			status: 200,
			contentType: file.type,
			body: Buffer.from(await file.arrayBuffer()),
		});
	});

	await page.setContent(html, { waitUntil: job.waitUntil as "load" });
	mkdirSync(dirname(job.outputPath), { recursive: true });

	if (job.kind === "image") {
		// With no explicit height, shrink the viewport to the content so the
		// image hugs it. documentElement reports the viewport height, not the
		// content's, so body is what has to be measured.
		if (job.height === undefined) {
			const contentHeight = Number(
				await page.evaluate("document.body.scrollHeight"),
			);
			if (Number.isFinite(contentHeight) && contentHeight > 0) {
				await page.setViewportSize({
					width: job.width ?? 1280,
					height: contentHeight,
				});
			}
		}
		const format = formatFromPath(job.outputPath);
		await page.screenshot({
			path: job.outputPath,
			fullPage: job.fullPage ?? true,
			type: format,
			omitBackground: job.transparent ?? false,
			...(format === "jpeg" && job.quality !== undefined
				? { quality: job.quality }
				: {}),
		});
	} else {
		await page.pdf({
			path: job.outputPath,
			...(job.pageWidth && job.pageHeight
				? { width: job.pageWidth, height: job.pageHeight }
				: { format: job.paperFormat ?? "a4" }),
			landscape: job.landscape ?? false,
			margin: job.margin ?? { top: "0", right: "0", bottom: "0", left: "0" },
			scale: job.scale ?? 1,
			printBackground: true,
		});
	}
} finally {
	await browser.close();
}
