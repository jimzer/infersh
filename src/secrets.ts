/**
 * `Secrets` — API key storage backed by the OS credential store.
 *
 * The default layer uses `Bun.secrets`, which talks to the macOS Keychain,
 * libsecret (GNOME Keyring, KWallet) on Linux, and the Windows Credential
 * Manager — so keys never land in a dotfile, a shell profile, or shell
 * history. Tests use {@link layerMemory} instead of touching the real store.
 */

import { Context, Data, Effect, Layer, Option, Redacted } from "effect";

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
	openrouter: {
		label: "OpenRouter",
		env: "OPENROUTER_API_KEY",
		url: "https://openrouter.ai/settings/keys",
	},
} as const satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof providers;

export const providerIds = Object.keys(providers) as [
	ProviderId,
	...ProviderId[],
];

/**
 * True when the OS has no usable credential store at all — a headless Linux
 * box without libsecret, a container, some WSL setups. Distinct from "the
 * store works but holds nothing", which is not an error.
 */
const isStoreUnavailable = (cause: unknown): boolean => {
	if (typeof cause !== "object" || cause === null) return false;
	const code = (cause as { code?: unknown }).code;
	if (code === "ERR_SECRETS_PLATFORM_ERROR") return true;
	const message = (cause as { message?: unknown }).message;
	return (
		typeof message === "string" && /libsecret|not available/i.test(message)
	);
};

export class SecretsError extends Data.TaggedError("SecretsError")<{
	readonly action: "read" | "write" | "delete";
	readonly provider: ProviderId;
	readonly cause: unknown;
}> {
	/** The OS credential store itself is missing, not just this key. */
	get unavailable(): boolean {
		return isStoreUnavailable(this.cause);
	}

	override get message(): string {
		if (this.unavailable) {
			return `No OS credential store available (${this.cause}).\nOn Linux install libsecret, or set ${providers[this.provider].env} in the environment instead.`;
		}
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

/**
 * The low-level credential store — the only part that touches the platform.
 * Swapping this is what makes the service testable without a real keychain.
 */
interface Store {
	readonly get: (name: string) => Promise<string | null>;
	readonly set: (name: string, value: string) => Promise<void>;
	readonly delete: (name: string) => Promise<boolean>;
}

const bunStore: Store = {
	get: (name) => Bun.secrets.get({ service: SERVICE, name }),
	set: (name, value) => Bun.secrets.set({ service: SERVICE, name, value }),
	delete: (name) => Bun.secrets.delete({ service: SERVICE, name }),
};

const memoryStore = (seed?: Partial<Record<ProviderId, string>>): Store => {
	const entries = new Map<string, string>(Object.entries(seed ?? {}));
	return {
		get: async (name) => entries.get(name) ?? null,
		set: async (name, value) => void entries.set(name, value),
		delete: async (name) => entries.delete(name),
	};
};

export interface SecretsShape {
	/** Resolves a key, preferring the environment variable over the store. */
	readonly get: (
		provider: ProviderId,
	) => Effect.Effect<Option.Option<ResolvedKey>, SecretsError>;
	readonly set: (
		provider: ProviderId,
		key: Redacted.Redacted,
	) => Effect.Effect<void, SecretsError>;
	/** Returns `false` when there was nothing stored to delete. */
	readonly remove: (
		provider: ProviderId,
	) => Effect.Effect<boolean, SecretsError>;
	/** Like {@link SecretsShape.get}, but fails when the key is absent. */
	readonly require: (
		provider: ProviderId,
	) => Effect.Effect<Redacted.Redacted, SecretsError | MissingKeyError>;
}

export class Secrets extends Context.Service<Secrets, SecretsShape>()(
	"Secrets",
) {}

const make = (
	store: Store,
	options: { readonly readEnv: boolean },
): SecretsShape => {
	const get: SecretsShape["get"] = (provider) =>
		Effect.gen(function* () {
			// An explicit env var wins so a shell or CI job can override the store.
			const fromEnv = options.readEnv
				? process.env[providers[provider].env]
				: undefined;
			if (fromEnv) {
				return Option.some({
					key: Redacted.make(fromEnv),
					source: "env" as const,
				});
			}
			const stored = yield* Effect.tryPromise({
				try: () => store.get(provider),
				catch: (cause) => new SecretsError({ action: "read", provider, cause }),
			});
			return stored === null
				? Option.none()
				: Option.some({
						key: Redacted.make(stored),
						source: "keychain" as const,
					});
		});

	return {
		get,
		set: (provider, key) =>
			Effect.tryPromise({
				try: () => store.set(provider, Redacted.value(key)),
				catch: (cause) =>
					new SecretsError({ action: "write", provider, cause }),
			}),
		remove: (provider) =>
			Effect.tryPromise({
				try: () => store.delete(provider),
				catch: (cause) =>
					new SecretsError({ action: "delete", provider, cause }),
			}),
		require: (provider) =>
			Effect.gen(function* () {
				const resolved = yield* get(provider);
				if (Option.isNone(resolved)) {
					return yield* Effect.fail(new MissingKeyError({ provider }));
				}
				return resolved.value.key;
			}),
	};
};

/** Backed by the real OS credential store. */
export const layer = Layer.succeed(Secrets)(make(bunStore, { readEnv: true }));

/** In-memory and env-blind, so tests stay isolated from the machine. */
export const layerMemory = (
	seed?: Partial<Record<ProviderId, string>>,
): Layer.Layer<Secrets> =>
	Layer.sync(Secrets)(() => make(memoryStore(seed), { readEnv: false }));

/** Renders a key for display: first and last 4 characters, rest masked. */
export const mask = (key: Redacted.Redacted): string => {
	const raw = Redacted.value(key);
	if (raw.length <= 8) return "•".repeat(Math.max(raw.length, 1));
	return `${raw.slice(0, 4)}${"•".repeat(6)}${raw.slice(-4)}`;
};
