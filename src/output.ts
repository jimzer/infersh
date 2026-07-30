/**
 * Machine-readable output.
 *
 * Every command accepts `--json`, and the guarantee is uniform: stdout is
 * exactly one JSON value. Payloads that are not already JSON — a rendered
 * path, an HTML page, a plain-text transcript — are wrapped rather than left
 * bare, so an agent never has to know which commands emit what shape.
 */

import { Console, type Effect } from "effect";
import { Flag } from "effect/unstable/cli";

export const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription(
		"Print the result as a single JSON value on stdout. Payloads that are not already JSON are wrapped in an object, so output is machine-readable the same way for every command.",
	),
);

/** Prints one JSON value, pretty-printed so a human can read it too. */
export const emitJson = (value: unknown): Effect.Effect<void> =>
	Console.log(JSON.stringify(value, null, 2));

/**
 * Wraps a provider payload that may or may not already be JSON.
 *
 * A string body (raw HTML, markdown, plain text) becomes `{ [key]: string }`;
 * anything already structured is returned as-is, so `--json` never
 * double-wraps a JSON response.
 */
export const wrapPayload = (payload: unknown, key: string): unknown =>
	typeof payload === "string" ? { [key]: payload } : payload;
