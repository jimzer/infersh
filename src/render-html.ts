/**
 * The pure pieces of `render html`.
 *
 * A composition becomes one self-contained file: React, the composition and
 * its packages bundled into an inline module script, Tailwind inlined, and
 * local files embedded as data URIs. The effectful orchestration lives in
 * `render.ts`; what is here can be tested without a browser or a filesystem.
 * See `docs/adrs/0021`.
 */

import { escapeForScript, escapeText } from "./html.ts";

/** Packages every page needs, whatever the composition imports. */
export const HTML_CORE_DEPS = ["react", "react-dom"] as const;

/**
 * A file's bytes as a data URI.
 *
 * Imported files are inlined from the flatten pass's own asset outputs rather
 * than through Bun's `dataurl` loader, which on Bun 1.4 replaces the import
 * with an empty string and reports success.
 */
export const dataUri = (type: string, bytes: Uint8Array): string =>
	`data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

/**
 * Mounts the composition in the browser.
 *
 * Client-side rather than pre-rendered and hydrated: a composition that
 * touches `window` while rendering would crash a server render, and
 * interactive ones often do.
 */
export const ENTRY_SOURCE = `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Composition from "./composition.tsx";

const slot = document.getElementById("infer-props");
const props = slot && slot.textContent ? JSON.parse(slot.textContent) : {};
createRoot(document.getElementById("root")!).render(createElement(Composition, props));
`;

/** True when a flattened bundle has a default export to mount. */
export const hasDefaultExport = (code: string): boolean =>
	/\bexport\s+default\b|\bas\s+default\b/.test(code);

/**
 * The document handed to Bun's standalone HTML build.
 *
 * Relative references in it — the entry script, an imported stylesheet, a
 * `--head` link to a local file — are inlined by that build. Props travel as
 * JSON in their own element rather than being spliced into the script.
 */
export const htmlDocument = (options: {
	readonly title: string;
	readonly props: unknown;
	readonly head?: string;
	/** Link the CSS the composition imported, so the build inlines it. */
	readonly stylesheet: boolean;
}): string => {
	const head = [
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeText(options.title)}</title>`,
		// Same reset image and pdf apply, so a composition looks the same in all three.
		"<style>html,body{margin:0;padding:0}</style>",
	];
	if (options.stylesheet) {
		head.push('<link rel="stylesheet" href="./composition.css">');
	}
	if (options.head) head.push(options.head);

	return `<!doctype html>
<html lang="en">
<head>
${head.join("\n")}
</head>
<body>
<div id="root"></div>
<noscript>This page is a React component and needs JavaScript to display.</noscript>
<script id="infer-props" type="application/json">${escapeForScript(JSON.stringify(options.props ?? {}))}</script>
<script type="module" src="./entry.ts"></script>
</body>
</html>`;
};

/** Inserts markup as the first thing inside `<head>`. */
export const prependToHead = (html: string, markup: string): string => {
	const open = /<head(\s[^>]*)?>/i.exec(html);
	if (open === null) return `${markup}${html}`;
	const at = open.index + open[0].length;
	return `${html.slice(0, at)}${markup}${html.slice(at)}`;
};

/**
 * Normalises a string that might name a file under `--assets`, or null.
 *
 * Anything addressable already (`https:`, `data:`, `//host`), a fragment, or
 * text that cannot be a path is rejected before the filesystem is touched.
 * `./logo.png`, `/logo.png` and `logo.png` all mean the same file, matching
 * how image and pdf resolve them against the asset directory.
 */
export const assetRef = (value: string): string | null => {
	if (value.length === 0 || value.length > 512) return null;
	if (/[\n\r\0]/.test(value)) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
	if (value.startsWith("//") || value.startsWith("#")) return null;
	const relative = value.replace(/^\.?\/+/, "");
	return relative === "" ? null : relative;
};

/**
 * Replaces string literals in JavaScript whose value `replace` maps.
 *
 * A lexical pass, not a parse: it can mis-pair quotes across a regex or
 * template literal, but a mis-paired span only matters if it happens to name
 * an existing file, and it is only replaced when it does. Strings containing
 * escapes are left alone, since their source text is not their value.
 */
export const replaceStringLiterals = (
	code: string,
	replace: (value: string) => string | null,
): string =>
	code.replace(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g, (literal, quote, value) => {
		if (value.includes("\\")) return literal;
		const next = replace(value);
		return next === null ? literal : `${quote}${next}${quote}`;
	});

/** Replaces every string inside a JSON value that `replace` maps. */
export const replaceJsonStrings = (
	value: unknown,
	replace: (value: string) => string | null,
): unknown => {
	if (typeof value === "string") return replace(value) ?? value;
	if (Array.isArray(value)) {
		return value.map((item) => replaceJsonStrings(item, replace));
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				replaceJsonStrings(item, replace),
			]),
		);
	}
	return value;
};
