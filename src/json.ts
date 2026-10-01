/**
 * Parsing JSON text through Schema, so malformed text is a decode failure the
 * caller handles rather than a `SyntaxError` thrown out of `JSON.parse`.
 */

import { Effect, Option, Schema } from "effect";

/** Any JSON value, from its text. Compose with a schema to also check shape. */
export const JsonText = Schema.fromJsonString(Schema.Unknown);

/** A JSON object: not an array, not `null`, not a primitive. */
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/** Parses JSON text, or `null` when it is not JSON. */
export const parseJson = (text: string): unknown =>
	Option.getOrNull(Schema.decodeUnknownOption(JsonText)(text));

/**
 * An optional field kept when it decodes and dropped when it does not.
 *
 * For fields that only add detail: a provider sending one as a string or
 * `null` should cost that field, not the whole record. Required fields stay
 * strict and fail the decode.
 */
export const lenient = <S extends Schema.Top>(schema: S) =>
	Schema.optionalKey(
		schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
	);

/**
 * Decodes each element on its own, keeping those that decode.
 *
 * For lists from a provider, where one malformed entry should drop that entry
 * rather than empty the whole list.
 */
export const decodeEach =
	<S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	(items: ReadonlyArray<unknown>): Array<S["Type"]> => {
		const decode = Schema.decodeUnknownOption(schema);
		return items.flatMap((item) => Option.toArray(decode(item)));
	};
