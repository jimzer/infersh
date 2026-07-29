/**
 * Build-time version stamping.
 *
 * `just bundle` passes `--define __VERSION__='"1.2.3"'`, so the released
 * single-file bundle knows its own version without reading package.json.
 * Running from source leaves the identifier undefined, which is what makes
 * `infer update` refuse to clobber a checkout.
 */

declare const __VERSION__: string;

/** The released version, or `"dev"` when running from source. */
export const VERSION: string =
	typeof __VERSION__ === "string" ? __VERSION__ : "dev";

export const isDev = (version: string = VERSION): boolean => version === "dev";

/** GitHub repository releases are published from. */
export const REPO = "jimzer/infersh";

/** The permanent "latest asset" URL — no API call, no token, no tag parsing. */
export const LATEST_ASSET_URL = `https://github.com/${REPO}/releases/latest/download/infer.js`;

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export { LATEST_RELEASE_API };

/** Strips a leading `v` so `v1.2.3` and `1.2.3` compare equal. */
export const normalize = (version: string): string =>
	version.trim().replace(/^v/, "");

/**
 * Compares two dotted numeric versions.
 * Returns a negative number when `a` is older, 0 when equal, positive when newer.
 * Non-numeric segments (`-beta.1`) are ignored beyond the numeric prefix.
 */
export const compare = (a: string, b: string): number => {
	const parse = (v: string) =>
		normalize(v)
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
};

/** True when `candidate` is strictly newer than `current`. */
export const isNewer = (candidate: string, current: string): boolean =>
	compare(candidate, current) > 0;
