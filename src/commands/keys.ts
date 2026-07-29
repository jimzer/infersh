/**
 * `infer keys` — manage the API keys held in the OS credential store.
 */

import { Console, Effect, Option, Redacted } from "effect";
import { Argument, Command, Prompt } from "effect/unstable/cli";
import {
	mask,
	providerIds,
	providers,
	type ResolvedKey,
	Secrets,
} from "../secrets.ts";

// Effect CLI reuses the full description in the parent's subcommand listing,
// so keep it to one line or `infer keys --help` turns into a wall of text.
const SET_DESCRIPTION =
	"Prompt for each provider API key (masked) and store it in the OS credential store.";

const setCmd = Command.make("set", {}, () =>
	Effect.gen(function* () {
		const secrets = yield* Secrets;
		yield* Console.log("Leave a prompt blank to keep the current value.\n");

		for (const id of providerIds) {
			const info = providers[id];
			const existing = yield* secrets.get(id);

			// An env var wins over the keychain at resolve time, so saving a key
			// here would have no visible effect until that var is unset.
			if (Option.isSome(existing) && existing.value.source === "env") {
				yield* Console.log(
					`${info.label}: using ${info.env} from the environment — skipping.`,
				);
				continue;
			}

			const hint = Option.isSome(existing) ? " (stored)" : "";
			const entered = yield* Prompt.password({
				message: `${info.label} API key${hint} — ${info.url}`,
			});

			const value = Redacted.value(entered).trim();
			if (value === "") {
				yield* Console.log(
					Option.isSome(existing)
						? `  kept existing ${info.label} key`
						: `  skipped ${info.label}`,
				);
				continue;
			}

			yield* secrets.set(id, Redacted.make(value));
			yield* Console.log(`  saved ${info.label} key`);
		}
	}),
).pipe(Command.withDescription(SET_DESCRIPTION));

const listCmd = Command.make("list", {}, () =>
	Effect.gen(function* () {
		const secrets = yield* Secrets;
		let unavailable = false;

		for (const id of providerIds) {
			// A machine with no credential store can still resolve keys from the
			// environment, so report that rather than failing the whole listing.
			const resolved = yield* secrets.get(id).pipe(
				Effect.catch((error) => {
					if (!error.unavailable) return Effect.fail(error);
					unavailable = true;
					return Effect.succeed(Option.none<ResolvedKey>());
				}),
			);
			const status = Option.isNone(resolved)
				? "not set"
				: `${mask(resolved.value.key)}  (${resolved.value.source})`;
			yield* Console.log(`${id.padEnd(12)} ${status}`);
		}

		if (unavailable) {
			yield* Console.log(
				"\nNo OS credential store available — only environment variables can be read.",
			);
		}
	}),
).pipe(
	Command.withDescription(
		"Show which provider keys are set, masked, and where each one resolves from.",
	),
);

const rmCmd = Command.make(
	"rm",
	{ provider: Argument.choice("provider", providerIds) },
	(config) =>
		Effect.gen(function* () {
			const secrets = yield* Secrets;
			const deleted = yield* secrets.remove(config.provider);
			const label = providers[config.provider].label;
			yield* Console.log(
				deleted ? `removed ${label} key` : `no stored ${label} key`,
			);
		}),
).pipe(
	Command.withDescription("Delete a stored key from the OS credential store."),
);

export const keysCmd = Command.make("keys").pipe(
	Command.withDescription("Manage provider API keys."),
	Command.withSubcommands([setCmd, listCmd, rmCmd]),
);
