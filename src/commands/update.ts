/**
 * `infer update` — replace the installed bundle with the latest release.
 */

import { chmodSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Console, Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
	ASSET_NAME,
	isDev,
	isNewer,
	LATEST_RELEASE_API,
	normalize,
	REPO,
	VERSION,
} from "../version.ts";

export class UpdateError extends Data.TaggedError("UpdateError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

const fetchJson = (url: string) =>
	Effect.tryPromise({
		try: async () => {
			const res = await fetch(url, {
				headers: {
					Accept: "application/vnd.github+json",
					// GitHub rejects API requests without a User-Agent.
					"User-Agent": `infer/${VERSION}`,
				},
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

/**
 * The most recent published release, with the exact asset URL for its tag.
 *
 * The `releases/latest/download/...` shortcut is deliberately not used: it is
 * CDN-cached and keeps serving the *previous* release's asset for a while
 * after a new one is published, which would silently "update" to the old
 * build.
 */
const latestRelease = Effect.gen(function* () {
	const body = yield* fetchJson(LATEST_RELEASE_API);
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
const installPath = Effect.try({
	try: () => realpathSync(Bun.main),
	catch: (cause) =>
		new UpdateError({
			reason: `Could not locate the running binary: ${cause}`,
		}),
});

/**
 * Downloads the new bundle and swaps it in.
 *
 * The temp file is written to the *same directory* as the target so the
 * rename is atomic; replacing a running script is safe because the kernel
 * keeps the current process on the old inode.
 */
const replaceBinary = (target: string, assetUrl: string) =>
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

const DESCRIPTION = `Update infer to the latest released version.

Downloads the single-file bundle attached to the latest GitHub release
and replaces the running binary in place.`;

export const updateCmd = Command.make(
	"update",
	{
		check: Flag.boolean("check").pipe(
			Flag.withDescription("Only report whether an update is available"),
		),
		force: Flag.boolean("force").pipe(
			Flag.withDescription("Reinstall even if already on the latest version"),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const { version: latest, assetUrl } = yield* latestRelease;

			if (isDev()) {
				yield* Console.log(
					`Running from source (latest release is v${latest}).`,
				);
				if (!config.force) return;
			} else {
				yield* Console.log(`Installed v${VERSION}, latest v${latest}.`);
			}

			const outdated = isDev() || isNewer(latest, VERSION);
			if (!outdated && !config.force) {
				yield* Console.log("Already up to date.");
				return;
			}

			if (config.check) {
				yield* Console.log(`Update available: run \`infer update\`.`);
				return;
			}

			const target = yield* installPath;
			// Overwriting a checked-out source tree would be destructive and is
			// never what someone running from source wants.
			if (target.endsWith(".ts")) {
				return yield* Effect.fail(
					new UpdateError({
						reason: `Refusing to overwrite the source file ${target}.\nInstall the released build instead: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`,
					}),
				);
			}

			yield* Console.log(`Downloading v${latest}...`);
			yield* replaceBinary(target, assetUrl);
			yield* Console.log(`Updated to v${latest} (${target}).`);
		}),
).pipe(Command.withDescription(DESCRIPTION));
