/**
 * Tailwind, inlined into every page that uses it.
 *
 * Every renderer embeds Tailwind v4's browser build as an inline `<script>`
 * rather than loading it from a CDN: a page then needs no network to be
 * styled, and an `.html` output stays portable. The browser build compiles in
 * the page after the composition runs, so it sees every class that actually
 * reaches the DOM — including names built at runtime, which build-time
 * scanning cannot. See `docs/adrs/0020`.
 *
 * The version is pinned: `cdn.tailwindcss.com` was unversioned, so renders
 * could change under us without a single line of ours changing.
 */

export const TAILWIND_NAME = "@tailwindcss/browser";
export const TAILWIND_VERSION = "4.3.3";

/** `name@version`, which both `bun install` and auto-install accept. */
export const TAILWIND_PACKAGE = `${TAILWIND_NAME}@${TAILWIND_VERSION}`;

/**
 * Wraps JavaScript in a `<script>` element that cannot be closed early.
 *
 * Inside a script element the HTML parser stops at the first `</script`, even
 * in a string or a comment. `<\/script` means the same thing to JavaScript in
 * every place that sequence can legally appear, so the rewrite is safe. The
 * original case is kept: rewriting `</SCRIPT` to lowercase would change the
 * value of a string that contains it.
 */
export const inlineScript = (code: string): string =>
	`<script>${code.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
