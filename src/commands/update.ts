/**
 * `infer update` — replace the installed bundle with the latest release.
 */

import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
	installPath,
	isSourceCheckout,
	latestRelease,
	replaceBinary,
	UpdateError,
} from "../update.ts";
import { isDev, isNewer, REPO, VERSION } from "../version.ts";

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
			const { version: latest, assetUrl } = yield* latestRelease();

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
				yield* Console.log("Update available: run `infer update`.");
				return;
			}

			const target = yield* installPath;
			// Overwriting a checked-out source tree would be destructive and is
			// never what someone running from source wants.
			if (isSourceCheckout(target)) {
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
