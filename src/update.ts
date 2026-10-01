/**
 * Update mechanics, shared by the `infer update` command and the startup
 * update check. See `docs/adrs/0004` and `docs/adrs/0005`.
 */

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	Data,
	type Duration,
	Effect,
	FileSystem,
	Option,
	Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { decodeEach } from "./json.ts";
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

/** GitHub rejects API requests without a User-Agent. */
const HEADERS = {
	Accept: "application/vnd.github+json",
	"User-Agent": `infer/${VERSION}`,
};

const fail = (reason: string) => new UpdateError({ reason });

const ReleaseBody = Schema.Struct({
	tag_name: Schema.NonEmptyString,
	assets: Schema.Array(Schema.Unknown),
});

const Asset = Schema.Struct({
	name: Schema.String,
	browser_download_url: Schema.String,
});

/** A release body, or why it is not one this CLI can install from. */
export const parseRelease = (body: unknown): Release | string =>
	Option.match(Schema.decodeUnknownOption(ReleaseBody)(body), {
		onNone: () => `No published release found for ${REPO}.`,
		onSome: (release) => {
			const asset = decodeEach(Asset)(release.assets).find(
				(a) => a.name === ASSET_NAME,
			);
			return asset === undefined
				? `Release ${release.tag_name} has no ${ASSET_NAME} asset attached.`
				: {
						version: normalize(release.tag_name),
						assetUrl: asset.browser_download_url,
					};
		},
	});

/**
 * The most recent published release, with the exact asset URL for its tag.
 *
 * The `releases/latest/download/...` shortcut is deliberately not used: it is
 * CDN-cached and keeps serving the *previous* release's asset for a while
 * after a new one is published, which would silently "update" to the old
 * build.
 */
export const latestRelease = (
	timeout?: Duration.Input,
): Effect.Effect<Release, UpdateError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient;
		const response = yield* http.get(LATEST_RELEASE_API, { headers: HEADERS });
		if (response.status >= 400) {
			return yield* Effect.fail(
				fail(`Could not check for updates: GitHub returned ${response.status}`),
			);
		}
		const release = parseRelease(yield* response.json);
		if (typeof release === "string") return yield* Effect.fail(fail(release));
		return release;
	}).pipe(
		timeout === undefined ? (effect) => effect : Effect.timeout(timeout),
		Effect.mapError((error) =>
			error._tag === "UpdateError"
				? error
				: fail(`Could not check for updates: ${error.message}`),
		),
	);

/**
 * The file to overwrite. Symlinks are resolved so that updating through a
 * symlinked bin directory rewrites the real bundle instead of the link.
 */
export const installPath: Effect.Effect<string, UpdateError> = Effect.try({
	try: () => realpathSync(Bun.main),
	catch: (cause) => fail(`Could not locate the running binary: ${cause}`),
});

/** A checkout runs from `.ts` sources and must never be overwritten. */
export const isSourceCheckout = (target: string): boolean =>
	target.endsWith(".ts");

/**
 * Downloads the new bundle and swaps it in.
 *
 * The temp file is written to the *same directory* as the target so the
 * rename is atomic; replacing a running script is safe because the kernel
 * keeps the current process on the old inode. If anything fails the temp file
 * is removed, so a partial download never lingers in the user's bin directory.
 */
export const replaceBinary = (
	target: string,
	assetUrl: string,
): Effect.Effect<
	void,
	UpdateError,
	HttpClient.HttpClient | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient;
		const fs = yield* FileSystem.FileSystem;
		const temp = join(dirname(target), `.infer.update.${process.pid}`);

		const response = yield* http.get(assetUrl, {
			headers: { "User-Agent": HEADERS["User-Agent"] },
		});
		if (response.status >= 400) {
			return yield* Effect.fail(
				fail(`download failed: GitHub returned ${response.status}`),
			);
		}
		const bytes = new Uint8Array(yield* response.arrayBuffer);
		if (bytes.length === 0) {
			return yield* Effect.fail(fail("downloaded an empty file"));
		}
		yield* Effect.gen(function* () {
			yield* fs.writeFile(temp, bytes);
			yield* fs.chmod(temp, 0o755);
			yield* fs.rename(temp, target);
		}).pipe(Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)));
	}).pipe(
		Effect.mapError((error) =>
			error._tag === "UpdateError"
				? new UpdateError({
						reason: `Could not install the update: ${error.reason}`,
					})
				: new UpdateError({
						reason: `Could not install the update: ${error.message}\nIs ${target} writable?`,
					}),
		),
	);
