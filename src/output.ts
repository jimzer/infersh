/**
 * Machine-readable output.
 *
 * Every command accepts `--json`, and the guarantee is uniform: stdout is
 * exactly one JSON value. Payloads that are not already JSON — a rendered
 * path, an HTML page, a plain-text transcript — are wrapped rather than left
 * bare, so an agent never has to know which commands emit what shape.
 */

import { format } from "node:util";
import { Console, type Effect } from "effect";
import { Flag } from "effect/cli";

export const jsonFlag = Flag.Boolean("json").pipe(
	Flag.withDefault(false),
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

/** Human-readable byte count for size warnings. */
export const formatBytes = (bytes: number): string => {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
};

/**
 * The CLI's console: stderr written without colour.
 *
 * stderr carries progress and notices — "Rendering image...", the update
 * notice, `ui`'s URL — as well as errors, and Bun paints every
 * `console.error` red on a terminal, so all of it read as a failure. Provided
 * once in `main.ts` in place of `globalThis.console`; stdout is untouched.
 */
export const plainConsole: Console.Console = Object.assign(
	Object.create(console),
	{
		error: (...args: ReadonlyArray<unknown>) =>
			void process.stderr.write(`${format(...args)}\n`),
		warn: (...args: ReadonlyArray<unknown>) =>
			void process.stderr.write(`${format(...args)}\n`),
	},
);
