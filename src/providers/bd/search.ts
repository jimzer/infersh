/**
 * Brightdata search — SERP API via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, type RequestBody } from "./client.ts";

const SEARCH_ENGINES: Record<string, string> = {
	google: "https://www.google.com/search?q=",
	bing: "https://www.bing.com/search?q=",
	yandex: "https://yandex.com/search/?text=",
};

// --- Schema ---

const SearchInput = Schema.Struct({
	query: Schema.String,
	searchEngine: Schema.optionalKey(Schema.String),
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
						Schema.toJsonSchemaDocument(SearchInput).schema,
						null,
						2,
					),
				);
				return;
			}
			const parsed = Schema.decodeUnknownSync(SearchInput)(
				JSON.parse(config.payload.value),
			);
			const engine = parsed.searchEngine ?? "google";
			const base = SEARCH_ENGINES[engine] ?? "https://www.google.com/search?q=";
			const body: RequestBody = {
				url: `${base}${encodeURIComponent(parsed.query)}`,
				zone: "sdk_serp",
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

export const searchCmd = Command.make(
	"search",
	{
		query: Argument.string("query"),
		dataFormat: Flag.choice("data-format", [
			"html",
			"markdown",
			"screenshot",
		] as const).pipe(Flag.optional),
		searchEngine: Flag.choice("search-engine", [
			"google",
			"bing",
			"yandex",
		] as const).pipe(Flag.optional),
		country: Flag.string("country").pipe(Flag.optional),
		format: Flag.choice("format", ["json", "raw"] as const).pipe(Flag.optional),
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const engine = Option.getOrElse(config.searchEngine, () => "google");
			const base = SEARCH_ENGINES[engine] ?? "https://www.google.com/search?q=";
			const body: RequestBody = {
				url: `${base}${encodeURIComponent(config.query)}`,
				zone: "sdk_serp",
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
