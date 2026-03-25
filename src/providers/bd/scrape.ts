/**
 * Brightdata scrape — Web Unlocker via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, type RequestBody } from "./client.ts";

// --- Schema ---

const ScrapeInput = Schema.Struct({
	url: Schema.String,
	dataFormat: Schema.optionalKey(Schema.String),
	country: Schema.optionalKey(Schema.String),
	format: Schema.optionalKey(Schema.String),
});

// --- JSON subcommand ---

const jsonCmd = Command.make(
	"json",
	{ payload: Argument.string("payload").pipe(Argument.optional) },
	(config) =>
		Effect.gen(function* () {
			if (Option.isNone(config.payload)) {
				yield* Console.log(
					JSON.stringify(
						Schema.toJsonSchemaDocument(ScrapeInput).schema,
						null,
						2,
					),
				);
				return;
			}
			const parsed = Schema.decodeUnknownSync(ScrapeInput)(
				JSON.parse(config.payload.value),
			);
			const body: RequestBody = {
				url: parsed.url,
				zone: "sdk_unlocker",
				...(parsed.dataFormat
					? { data_format: parsed.dataFormat as RequestBody["data_format"] }
					: {}),
				...(parsed.country ? { country: parsed.country } : {}),
				...(parsed.format
					? { format: parsed.format as RequestBody["format"] }
					: {}),
			};
			const bd = yield* Bd;
			yield* Console.log(yield* bd.request(body));
		}),
);

// --- Main command ---

export const scrapeCmd = Command.make(
	"scrape",
	{
		url: Argument.string("url"),
		dataFormat: Flag.choice("data-format", [
			"html",
			"markdown",
			"screenshot",
		] as const).pipe(Flag.optional),
		country: Flag.string("country").pipe(Flag.optional),
		format: Flag.choice("format", ["json", "raw"] as const).pipe(Flag.optional),
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const body: RequestBody = {
				url: config.url,
				zone: "sdk_unlocker",
				...(Option.isSome(config.dataFormat)
					? { data_format: config.dataFormat.value }
					: {}),
				...(Option.isSome(config.country)
					? { country: config.country.value }
					: {}),
				...(Option.isSome(config.format)
					? { format: config.format.value }
					: {}),
			};
			yield* Console.log(yield* bd.request(body));
		}),
).pipe(Command.withSubcommands([jsonCmd]));
