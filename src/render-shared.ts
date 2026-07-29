/**
 * Pure helpers shared by the CLI and the render child.
 *
 * This module is embedded as text and written beside the child, so it must
 * stay dependency-free.
 */

import { extname, join, resolve } from "node:path";

export const ASSET_ORIGIN = "http://assets.infer.local";

export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Picks the image format from the output extension. */
export const formatFromPath = (path: string): ImageFormat => {
	const ext = extname(path).slice(1).toLowerCase();
	if (ext === "jpg" || ext === "jpeg") return "jpeg";
	if (ext === "webp") return "webp";
	return "png";
};

/** Wraps rendered markup in a document, pointing assets at the intercepted origin. */
export const buildHtml = (options: {
	readonly markup: string;
	readonly head?: string;
	readonly tailwind: boolean;
	readonly transparent: boolean;
}): string => {
	const parts = [
		`<base href="${ASSET_ORIGIN}/">`,
		// Chrome's default 8px body margin would show as a border on a captured
		// composition, so it is always reset.
		"<style>html,body{margin:0;padding:0}</style>",
	];
	if (options.tailwind) {
		parts.push('<script src="https://cdn.tailwindcss.com"></script>');
	}
	if (options.transparent) {
		parts.push("<style>html,body{background:transparent !important}</style>");
	}
	if (options.head) parts.push(options.head);

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${parts.join("\n")}
</head>
<body>
${options.markup}
</body>
</html>`;
};

/**
 * Maps an intercepted URL to a file inside the asset directory.
 *
 * Returns null when the path escapes the directory, so a composition cannot
 * read arbitrary files by asking for `../../etc/passwd`.
 */
export const assetPathFor = (url: string, assetDir: string): string | null => {
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(url).pathname);
	} catch {
		return null;
	}
	const root = resolve(assetDir);
	const target = resolve(join(root, pathname));
	if (target !== root && !target.startsWith(`${root}/`)) return null;
	return target;
};
