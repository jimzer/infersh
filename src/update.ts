/**
 * Update mechanics, shared by the `infer update` command and the startup
 * update check. See `docs/adrs/0004` and `docs/adrs/0005`.
 */

import { chmodSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import {
	ASSET_NAME,
	LATEST_RELEASE_API,
	normalize,
	REPO,
	VERSION,
} from "./version.ts";

export class UpdateError extends Data.TaggedError("UpdateError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

export interface Release {
	readonly version: string;
	readonly assetUrl: string;
}

/**
 * The most recent published release, with the exact asset URL for its tag.
 *
 * The `releases/latest/download/...` shortcut is deliberately not used: it is
 * CDN-cached and keeps serving the *previous* release's asset for a while
 * after a new one is published, which would silently "update" to the old
 * build.
 */
export const latestRelease = (
	timeoutMs?: number,
): Effect.Effect<Release, UpdateError> =>
	Effect.gen(function* () {
		const body = yield* Effect.tryPromise({
			try: async () => {
				const res = await fetch(LATEST_RELEASE_API, {
					headers: {
						Accept: "application/vnd.github+json",
						// GitHub rejects API requests without a User-Agent.
						"User-Agent": `infer/${VERSION}`,
					},
					...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
				});
				if (!res.ok) {
					throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
				}
				return (await res.json()) as {
					tag_name?: string;
					assets?: ReadonlyArray<{
						name?: string;
						browser_download_url?: string;
					}>;
				};
			},
			catch: (cause) =>
				new UpdateError({ reason: `Could not check for updates: ${cause}` }),
		});

		if (!body.tag_name) {
			return yield* Effect.fail(
				new UpdateError({ reason: `No published release found for ${REPO}.` }),
			);
		}
		const asset = body.assets?.find((a) => a.name === ASSET_NAME);
		if (!asset?.browser_download_url) {
			return yield* Effect.fail(
				new UpdateError({
					reason: `Release ${body.tag_name} has no ${ASSET_NAME} asset attached.`,
				}),
			);
		}
		return {
			version: normalize(body.tag_name),
			assetUrl: asset.browser_download_url,
		};
	});

/**
 * The file to overwrite. Symlinks are resolved so that updating through a
 * symlinked bin directory rewrites the real bundle instead of the link.
 */
export const installPath: Effect.Effect<string, UpdateError> = Effect.try({
	try: () => realpathSync(Bun.main),
	catch: (cause) =>
		new UpdateError({
			reason: `Could not locate the running binary: ${cause}`,
		}),
});

/** A checkout runs from `.ts` sources and must never be overwritten. */
export const isSourceCheckout = (target: string): boolean =>
	target.endsWith(".ts");

/**
 * Downloads the new bundle and swaps it in.
 *
 * The temp file is written to the *same directory* as the target so the
 * rename is atomic; replacing a running script is safe because the kernel
 * keeps the current process on the old inode.
 */
export const replaceBinary = (
	target: string,
	assetUrl: string,
): Effect.Effect<void, UpdateError> =>
	Effect.gen(function* () {
		const temp = join(dirname(target), `.infer.update.${process.pid}`);
		yield* Effect.tryPromise({
			try: async () => {
				const res = await fetch(assetUrl, {
					headers: { "User-Agent": `infer/${VERSION}` },
				});
				if (!res.ok) {
					throw new Error(`download failed: ${res.status} ${res.statusText}`);
				}
				const bytes = await res.bytes();
				if (bytes.length === 0) throw new Error("downloaded an empty file");
				await Bun.write(temp, bytes);
				chmodSync(temp, 0o755);
				renameSync(temp, target);
			},
			catch: (cause) => {
				// Never leave a partial file behind in the user's bin directory.
				try {
					unlinkSync(temp);
				} catch {}
				return new UpdateError({
					reason: `Could not install the update: ${cause}\nIs ${target} writable?`,
				});
			},
		});
	});
