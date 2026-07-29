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

// `withShortDescription` is what the parent's subcommand listing shows, so
// `withDescription` is free to be as long as it needs to be.

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
).pipe(
	Command.withShortDescription("Store each provider API key, interactively."),
	Command.withDescription(
		`Prompt for each provider API key and save it to the OS credential store.

Input is masked as you type. Leaving a prompt blank keeps whatever is
already stored, so you can update one key without retyping the others.

Keys are held in the macOS Keychain, libsecret on Linux, or the Windows
Credential Manager — never on disk in plain text. A provider whose key
is already supplied by an environment variable is skipped, because that
variable would take precedence anyway.`,
	),
	Command.withExamples([
		{
			command: "infer keys set",
			description: "Set or update every provider key",
		},
	]),
);

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
	Command.withShortDescription("Show which provider keys are set."),
	Command.withDescription(
		`List each provider key, masked, with where it resolves from.

The source is either \`env\` or \`keychain\`. An environment variable wins
over a stored key, so this is the quickest way to see which value a
command will actually use.

On a machine with no credential store — a container, a headless server,
some WSL setups — only environment variables can be read, and that is
reported rather than treated as an error.`,
	),
	Command.withExamples([
		{ command: "infer keys list", description: "Show every provider key" },
	]),
);

const rmCmd = Command.make(
	"rm",
	{
		provider: Argument.choice("provider", providerIds).pipe(
			Argument.withDescription(
				"Which provider's key to delete. Only the stored key is removed; an environment variable of the same name is untouched.",
			),
		),
	},
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
	Command.withShortDescription("Delete a stored provider key."),
	Command.withDescription(
		`Remove one provider's key from the OS credential store.

Reports whether anything was actually deleted, so running it twice is
harmless. This cannot remove a key that comes from an environment
variable — unset that in your shell instead.`,
	),
	Command.withExamples([
		{
			command: "infer keys rm fal",
			description: "Forget the stored fal.ai key",
		},
	]),
);

export const keysCmd = Command.make("keys").pipe(
	Command.withShortDescription("Manage provider API keys."),
	Command.withDescription(
		`Manage the provider API keys held in the OS credential store.

Keys resolve from the environment first and the credential store
second, so a shell or CI job can override a stored key without
replacing it:

  fal         FAL_KEY
  brightdata  BRIGHTDATA_API_KEY
  groq        GROQ_API_KEY`,
	),
	Command.withSubcommands([setCmd, listCmd, rmCmd]),
);
