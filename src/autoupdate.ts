/**
 * Startup update check.
 *
 * Runs *after* the invoked command finishes, so it never delays output and
 * never swaps the binary while it is doing work. Notifies by default;
 * installs only when explicitly opted in. See `docs/adrs/0007`.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
	installPath,
	isSourceCheckout,
	latestRelease,
	replaceBinary,
} from "./update.ts";
import { isDev, isNewer, VERSION } from "./version.ts";

/** Check at most once a day; every other invocation reads the cache only. */
export const TTL_MS = 24 * 60 * 60 * 1000;

/** The check must never noticeably delay the CLI, even on a bad network. */
const TIMEOUT_MS = 1500;

export type Mode = "off" | "notify" | "auto";

const truthy = (value: string | undefined): boolean =>
	value !== undefined && value !== "" && value !== "0" && value !== "false";

/**
 * What the startup check is allowed to do.
 *
 * Auto-installing on every start is deliberately not the default: it makes a
 * script's behaviour change under it mid-run, and the unauthenticated GitHub
 * API allows only 60 requests/hour/IP, which a CLI called in a loop would
 * exhaust.
 */
export const modeFor = (options: {
	readonly version: string;
	readonly env: Record<string, string | undefined>;
	readonly interactive: boolean;
}): Mode => {
	const { version, env, interactive } = options;
	// A source checkout has nothing to update to.
	if (isDev(version)) return "off";
	if (truthy(env.INFER_NO_UPDATE_CHECK)) return "off";
	// CI should be reproducible and is never the place to self-modify.
	if (truthy(env.CI)) return "off";
	if (truthy(env.INFER_AUTO_UPDATE)) return "auto";
	// Piped or redirected output means a script is reading us; stay silent.
	return interactive ? "notify" : "off";
};

export const isStale = (
	checkedAt: number,
	now: number,
	ttlMs: number = TTL_MS,
): boolean => now - checkedAt >= ttlMs;

export interface CacheEntry {
	readonly checkedAt: number;
	readonly latest: string;
}

export const cachePath = (
	env: Record<string, string | undefined> = process.env,
): string =>
	join(
		env.XDG_CACHE_HOME || join(homedir(), ".cache"),
		"infer",
		"update-check.json",
	);

/** Any cache problem is ignored — a broken cache must not break the CLI. */
export const parseCache = (raw: string): CacheEntry | null => {
	try {
		const parsed = JSON.parse(raw) as Partial<CacheEntry>;
		if (typeof parsed.checkedAt !== "number") return null;
		if (typeof parsed.latest !== "string" || parsed.latest === "") return null;
		return { checkedAt: parsed.checkedAt, latest: parsed.latest };
	} catch {
		return null;
	}
};

const readCache = async (path: string): Promise<CacheEntry | null> => {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return null;
		return parseCache(await file.text());
	} catch {
		return null;
	}
};

const writeCache = async (path: string, entry: CacheEntry): Promise<void> => {
	try {
		mkdirSync(dirname(path), { recursive: true });
		await Bun.write(path, JSON.stringify(entry));
	} catch {
		// A read-only or full home directory is not the CLI's problem.
	}
};

/**
 * Resolves the latest known version, using the cache when it is fresh so the
 * common invocation performs no network I/O at all.
 */
const knownLatest = async (
	path: string,
	now: number,
): Promise<string | null> => {
	const cached = await readCache(path);
	if (cached && !isStale(cached.checkedAt, now)) return cached.latest;

	const release = await Effect.runPromise(
		latestRelease(TIMEOUT_MS).pipe(Effect.option),
	);
	if (release._tag === "None") {
		// Offline or rate-limited: fall back to whatever we last knew.
		return cached?.latest ?? null;
	}
	await writeCache(path, { checkedAt: now, latest: release.value.version });
	return release.value.version;
};

const installLatest = async (): Promise<string | null> => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const target = yield* installPath;
			if (isSourceCheckout(target)) return null;
			const release = yield* latestRelease(TIMEOUT_MS);
			yield* replaceBinary(target, release.assetUrl);
			return release.version;
		}).pipe(Effect.option),
	);
	return result._tag === "Some" ? result.value : null;
};

/**
 * Runs the startup check. Never throws and never returns a failure — an
 * update check must not be able to break the command the user actually ran.
 */
export const runUpdateCheck = async (): Promise<void> => {
	try {
		const mode = modeFor({
			version: VERSION,
			env: process.env,
			interactive: process.stderr.isTTY === true,
		});
		if (mode === "off") return;

		const latest = await knownLatest(cachePath(), Date.now());
		if (latest === null || !isNewer(latest, VERSION)) return;

		if (mode === "notify") {
			process.stderr.write(
				`\ninfer v${latest} is available (you have v${VERSION}) — run \`infer update\`\n`,
			);
			return;
		}

		const installed = await installLatest();
		if (installed !== null) {
			process.stderr.write(`\ninfer updated to v${installed}\n`);
		}
	} catch {
		// Deliberately silent.
	}
};
