import { describe, expect, test } from "bun:test";
import { Effect, Option, Redacted } from "effect";
import {
	layerMemory,
	MissingKeyError,
	mask,
	type ProviderId,
	Secrets,
	SecretsError,
} from "./secrets.ts";

/** Runs an effect against an isolated in-memory store — never the keychain. */
const run = <A, E>(
	effect: Effect.Effect<A, E, Secrets>,
	seed?: Partial<Record<ProviderId, string>>,
): Promise<A> =>
	effect.pipe(Effect.provide(layerMemory(seed)), Effect.runPromise);

describe("Secrets", () => {
	test("returns none when nothing is stored", async () => {
		const found = await run(
			Effect.gen(function* () {
				return yield* (yield* Secrets).get("fal");
			}),
		);
		expect(Option.isNone(found)).toBe(true);
	});

	test("round-trips a stored key", async () => {
		const found = await run(
			Effect.gen(function* () {
				const secrets = yield* Secrets;
				yield* secrets.set("fal", Redacted.make("sk-test-1234"));
				return yield* secrets.get("fal");
			}),
		);
		expect(Option.isSome(found)).toBe(true);
		if (Option.isSome(found)) {
			expect(Redacted.value(found.value.key)).toBe("sk-test-1234");
			expect(found.value.source).toBe("keychain");
		}
	});

	test("overwrites an existing key", async () => {
		const value = await run(
			Effect.gen(function* () {
				const secrets = yield* Secrets;
				yield* secrets.set("groq", Redacted.make("first"));
				yield* secrets.set("groq", Redacted.make("second"));
				return yield* secrets.require("groq");
			}),
		);
		expect(Redacted.value(value)).toBe("second");
	});

	test("remove reports whether anything was deleted", async () => {
		const [first, second] = await run(
			Effect.gen(function* () {
				const secrets = yield* Secrets;
				return [
					yield* secrets.remove("brightdata"),
					yield* secrets.remove("brightdata"),
				] as const;
			}),
			{ brightdata: "stored" },
		);
		expect(first).toBe(true);
		expect(second).toBe(false);
	});

	test("keys are isolated per provider", async () => {
		const other = await run(
			Effect.gen(function* () {
				const secrets = yield* Secrets;
				yield* secrets.set("fal", Redacted.make("fal-key"));
				return yield* secrets.get("groq");
			}),
		);
		expect(Option.isNone(other)).toBe(true);
	});

	test("require fails with MissingKeyError naming the env var", async () => {
		const error = await run(
			Effect.gen(function* () {
				return yield* Effect.flip((yield* Secrets).require("groq"));
			}),
		);
		expect(error).toBeInstanceOf(MissingKeyError);
		expect(error.message).toContain("GROQ_API_KEY");
	});

	test("a seeded store resolves without the environment", async () => {
		const value = await run(
			Effect.gen(function* () {
				return yield* (yield* Secrets).require("fal");
			}),
			{ fal: "seeded-key" },
		);
		expect(Redacted.value(value)).toBe("seeded-key");
	});

	test("the memory layer ignores env vars, so tests stay isolated", async () => {
		process.env.FAL_KEY = "leaked-from-the-machine";
		try {
			const found = await run(
				Effect.gen(function* () {
					return yield* (yield* Secrets).get("fal");
				}),
			);
			expect(Option.isNone(found)).toBe(true);
		} finally {
			delete process.env.FAL_KEY;
		}
	});
});

describe("SecretsError.unavailable", () => {
	const error = (cause: unknown) =>
		new SecretsError({ action: "read", provider: "fal", cause });

	test("detects the Bun platform error code", () => {
		expect(error({ code: "ERR_SECRETS_PLATFORM_ERROR" }).unavailable).toBe(
			true,
		);
	});

	test("detects a missing libsecret by message", () => {
		expect(error(new Error("libsecret not available")).unavailable).toBe(true);
	});

	test("points at the env var when there is no store", () => {
		expect(error(new Error("libsecret not available")).message).toContain(
			"FAL_KEY",
		);
	});

	test("an ordinary failure is not a missing store", () => {
		expect(error(new Error("keychain access denied")).unavailable).toBe(false);
		expect(error("boom").unavailable).toBe(false);
		expect(error(null).unavailable).toBe(false);
	});
});

describe("mask", () => {
	test("shows the first and last four characters", () => {
		expect(mask(Redacted.make("abcdefghijklmnop"))).toBe("abcd••••••mnop");
	});

	test("fully masks short values", () => {
		expect(mask(Redacted.make("abcd"))).toBe("••••");
	});

	test("never renders an empty string for an empty key", () => {
		expect(mask(Redacted.make(""))).toBe("•");
	});
});
