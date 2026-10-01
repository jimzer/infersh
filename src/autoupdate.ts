/**
 * Startup update check.
 *
 * Runs *after* the invoked command finishes, so it never delays output and
 * never swaps the binary while it is doing work. Notifies by default;
 * installs only when explicitly opted in. See `docs/adrs/0007`.
 */

import { join } from "node:path";
import {
	Clock,
	Console,
	Effect,
	type FileSystem,
	Option,
	Schema,
} from "effect";
import type { HttpClient } from "effect/http";
import { cacheDir, readFile, writeFile } from "./stage.ts";
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
const TIMEOUT = "1500 millis";

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
): string => join(cacheDir(env), "update-check.json");

const CacheFile = Schema.fromJsonString(
	Schema.Struct({ checkedAt: Schema.Finite, latest: Schema.NonEmptyString }),
);

/** Any cache problem is ignored — a broken cache must not break the CLI. */
export const parseCache = (raw: string): CacheEntry | null =>
	Option.getOrNull(Schema.decodeUnknownOption(CacheFile)(raw));

const readCache = (
	path: string,
): Effect.Effect<CacheEntry | null, never, FileSystem.FileSystem> =>
	readFile(path).pipe(
		Effect.map(parseCache),
		Effect.orElseSucceed(() => null),
	);

/** A read-only or full home directory is not the CLI's problem. */
const writeCache = (
	path: string,
	entry: CacheEntry,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	writeFile(path, JSON.stringify(entry)).pipe(Effect.ignore);

type Services = HttpClient.HttpClient | FileSystem.FileSystem;

/**
 * Resolves the latest known version, using the cache when it is fresh so the
 * common invocation performs no network I/O at all.
 */
const knownLatest = (
	path: string,
	now: number,
): Effect.Effect<string | null, never, Services> =>
	Effect.gen(function* () {
		const cached = yield* readCache(path);
		if (cached && !isStale(cached.checkedAt, now)) return cached.latest;

		const release = yield* latestRelease(TIMEOUT).pipe(Effect.option);
		// Offline or rate-limited: fall back to whatever we last knew.
		if (Option.isNone(release)) return cached?.latest ?? null;
		yield* writeCache(path, { checkedAt: now, latest: release.value.version });
		return release.value.version;
	});

const installLatest: Effect.Effect<string | null, never, Services> = Effect.gen(
	function* () {
		const target = yield* installPath;
		if (isSourceCheckout(target)) return null;
		const release = yield* latestRelease(TIMEOUT);
		yield* replaceBinary(target, release.assetUrl);
		return release.version;
	},
).pipe(Effect.orElseSucceed(() => null));

/**
 * The startup check, run by `main.ts` after the command has finished.
 *
 * It cannot fail: every cause, defects included, is swallowed — an update
 * check must never be able to break the command the user actually ran.
 */
export const updateCheck: Effect.Effect<void, never, Services> = Effect.gen(
	function* () {
		const mode = modeFor({
			version: VERSION,
			env: process.env,
			interactive: process.stderr.isTTY === true,
		});
		if (mode === "off") return;

		const now = yield* Clock.currentTimeMillis;
		const latest = yield* knownLatest(cachePath(), now);
		if (latest === null || !isNewer(latest, VERSION)) return;

		if (mode === "notify") {
			yield* Console.error(
				`\ninfer v${latest} is available (you have v${VERSION}) — run \`infer update\``,
			);
			return;
		}

		const installed = yield* installLatest;
		if (installed !== null) {
			yield* Console.error(`\ninfer updated to v${installed}`);
		}
	},
).pipe(Effect.catchCause(() => Effect.void));
