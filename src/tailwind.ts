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
