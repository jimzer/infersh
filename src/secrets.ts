/**
 * API key storage backed by the OS credential store.
 *
 * `Bun.secrets` talks to the macOS Keychain, libsecret (GNOME Keyring,
 * KWallet) on Linux, and the Windows Credential Manager — so keys never
 * land in a dotfile, a shell profile, or shell history.
 */

import { Data, Effect, Option, Redacted } from "effect";

/** Keychain service name. Every key is stored under `<SERVICE>/<providerId>`. */
const SERVICE = "infersh";

export interface ProviderInfo {
	readonly label: string;
	/** Checked before the keychain, so CI can inject a key without prompting. */
	readonly env: string;
	/** Where to go to mint a key. */
	readonly url: string;
}

export const providers = {
	fal: {
		label: "fal.ai",
		env: "FAL_KEY",
		url: "https://fal.ai/dashboard/keys",
	},
	brightdata: {
		label: "Bright Data",
		env: "BRIGHTDATA_API_KEY",
		url: "https://brightdata.com/cp/setting/users",
	},
	groq: {
		label: "Groq",
		env: "GROQ_API_KEY",
		url: "https://console.groq.com/keys",
	},
} as const satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof providers;

export const providerIds = Object.keys(providers) as [
	ProviderId,
	...ProviderId[],
];

export class SecretsError extends Data.TaggedError("SecretsError")<{
	readonly action: "read" | "write" | "delete";
	readonly provider: ProviderId;
	readonly cause: unknown;
}> {
	override get message(): string {
		return `Failed to ${this.action} the ${providers[this.provider].label} key: ${this.cause}`;
	}
}

export class MissingKeyError extends Data.TaggedError("MissingKeyError")<{
	readonly provider: ProviderId;
}> {
	override get message(): string {
		const info = providers[this.provider];
		return `No ${info.label} API key found. Run \`infer keys set\`, or set ${info.env}.`;
	}
}

/** Where a resolved key came from. */
export type KeySource = "env" | "keychain";

export interface ResolvedKey {
	readonly key: Redacted.Redacted;
	readonly source: KeySource;
}

export const set = (
	provider: ProviderId,
	key: Redacted.Redacted,
): Effect.Effect<void, SecretsError> =>
	Effect.tryPromise({
		try: () =>
			Bun.secrets.set({
				service: SERVICE,
				name: provider,
				value: Redacted.value(key),
			}),
		catch: (cause) => new SecretsError({ action: "write", provider, cause }),
	});

export const remove = (
	provider: ProviderId,
): Effect.Effect<boolean, SecretsError> =>
	Effect.tryPromise({
		try: () => Bun.secrets.delete({ service: SERVICE, name: provider }),
		catch: (cause) => new SecretsError({ action: "delete", provider, cause }),
	});

/** Reads the keychain only — ignores the environment. */
const fromKeychain = (
	provider: ProviderId,
): Effect.Effect<string | null, SecretsError> =>
	Effect.tryPromise({
		try: () => Bun.secrets.get({ service: SERVICE, name: provider }),
		catch: (cause) => new SecretsError({ action: "read", provider, cause }),
	});

/**
 * Resolves a key, preferring the environment variable so a shell or CI job
 * can override what is in the keychain.
 */
export const get = (
	provider: ProviderId,
): Effect.Effect<Option.Option<ResolvedKey>, SecretsError> =>
	Effect.gen(function* () {
		const fromEnv = process.env[providers[provider].env];
		if (fromEnv) {
			return Option.some({
				key: Redacted.make(fromEnv),
				source: "env" as const,
			});
		}
		const stored = yield* fromKeychain(provider);
		return stored === null
			? Option.none()
			: Option.some({
					key: Redacted.make(stored),
					source: "keychain" as const,
				});
	});

/** Like {@link get}, but fails when the key is absent. For provider call sites. */
export const requireKey = (
	provider: ProviderId,
): Effect.Effect<Redacted.Redacted, SecretsError | MissingKeyError> =>
	Effect.gen(function* () {
		const resolved = yield* get(provider);
		if (Option.isNone(resolved)) {
			return yield* Effect.fail(new MissingKeyError({ provider }));
		}
		return resolved.value.key;
	});

/** Renders a key for display: first and last 4 characters, rest masked. */
export const mask = (key: Redacted.Redacted): string => {
	const raw = Redacted.value(key);
	if (raw.length <= 8) return "•".repeat(Math.max(raw.length, 1));
	return `${raw.slice(0, 4)}${"•".repeat(6)}${raw.slice(-4)}`;
};
