/**
 * `infer bdata` — Bright Data web scraping and search.
 */

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
	Bdata,
	BdataError,
	DATA_FORMATS,
	FORMATS,
	METHODS,
	mergeOptions,
	parseInput,
	renderResult,
	SEARCH_ENGINES,
	type SearchEngine,
} from "../bdata.ts";

const SCRAPE_KEYS = [
	"zone",
	"country",
	"method",
	"format",
	"dataFormat",
	"concurrency",
	"timeout",
] as const;

const SEARCH_KEYS = [
	...SCRAPE_KEYS,
	"language",
	"numResults",
	"start",
] as const;

const INPUT_NOTE =
	'All options as one JSON object, e.g. \'{"dataFormat":"markdown","country":"gb"}\'. An alternative to the flags for programmatic callers; unknown keys are rejected rather than ignored. An explicitly passed flag wins over the same key here.';

// Flags shared by both subcommands, mirroring the SDK's base option schema.
const baseFlags = {
	format: Flag.choice("format", FORMATS).pipe(
		Flag.optional,
		Flag.withDescription(
			"raw (default) returns the page or results as text; json returns a structured object worth piping into jq.",
		),
	),
	dataFormat: Flag.choice("data-format", DATA_FORMATS).pipe(
		Flag.optional,
		Flag.withDescription(
			"Shape of the returned content: html (default), markdown (md is an alias) for LLM-friendly text, or screenshot for a PNG.",
		),
	),
	country: Flag.string("country").pipe(
		Flag.withMetavar("cc"),
		Flag.optional,
		Flag.withDescription(
			"Two-letter ISO 3166-1 country code to route the request through, e.g. gb or us. Changes geo-targeted results.",
		),
	),
	method: Flag.choice("method", METHODS).pipe(
		Flag.optional,
		Flag.withDescription("HTTP method for the request. Defaults to GET."),
	),
	zone: Flag.string("zone").pipe(
		Flag.withMetavar("name"),
		Flag.optional,
		Flag.withDescription(
			"Bright Data zone to bill against. Created automatically when omitted.",
		),
	),
	concurrency: Flag.integer("concurrency").pipe(
		Flag.withMetavar("1-50"),
		Flag.optional,
		Flag.withDescription(
			"How many of a batch to process in parallel. Defaults to 10; only matters when passing several targets.",
		),
	),
	timeout: Flag.integer("timeout").pipe(
		Flag.withMetavar("ms"),
		Flag.optional,
		Flag.withDescription(
			"Per-request timeout in milliseconds, between 250 and 300000. Defaults to 120000.",
		),
	),
	input: Flag.string("input").pipe(
		Flag.withMetavar("json"),
		Flag.optional,
		Flag.withDescription(INPUT_NOTE),
	),
};

const baseOptions = (config: {
	readonly format: Option.Option<string>;
	readonly dataFormat: Option.Option<string>;
	readonly country: Option.Option<string>;
	readonly method: Option.Option<string>;
	readonly zone: Option.Option<string>;
	readonly concurrency: Option.Option<number>;
	readonly timeout: Option.Option<number>;
}) => ({
	format: Option.getOrUndefined(config.format),
	dataFormat: Option.getOrUndefined(config.dataFormat),
	country: Option.getOrUndefined(config.country),
	method: Option.getOrUndefined(config.method),
	zone: Option.getOrUndefined(config.zone),
	concurrency: Option.getOrUndefined(config.concurrency),
	timeout: Option.getOrUndefined(config.timeout),
});

const resolveOptions = <A extends object>(
	input: Option.Option<string>,
	allowed: ReadonlyArray<string>,
	flags: A,
): Effect.Effect<A, BdataError> =>
	Effect.gen(function* () {
		if (Option.isNone(input)) return mergeOptions({}, flags);
		const parsed = parseInput(input.value, allowed);
		if ("error" in parsed) {
			return yield* Effect.fail(new BdataError({ reason: parsed.error }));
		}
		return mergeOptions(parsed.options, flags);
	});

// --- scrape ---------------------------------------------------------------

const scrapeCmd = Command.make(
	"scrape",
	{
		urls: Argument.string("url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more URLs to scrape. Several URLs are fetched in parallel and returned as an array, in the order given.",
			),
		),
		...baseFlags,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const options = yield* resolveOptions(
				config.input,
				SCRAPE_KEYS,
				baseOptions(config),
			);
			const result = yield* bdata.scrape(config.urls, options);
			yield* Console.log(renderResult(result));
		}),
).pipe(
	Command.withShortDescription("Scrape one or more URLs."),
	Command.withDescription(
		`Fetch web pages through Bright Data's web unlocker.

Handles anti-bot protection and proxying, so pages that block a plain
request generally come back intact.

Output goes to stdout: --format raw (the default) prints the page as
text, while --format json prints a structured object ready for jq.
For feeding a page to an LLM, --data-format markdown is usually the
most useful combination.

Requires a Bright Data API key: run \`infer keys set\` or set
BRIGHTDATA_API_KEY.`,
	),
	Command.withExamples([
		{
			command: "infer bdata scrape https://example.com",
			description: "Fetch a page as HTML",
		},
		{
			command: "infer bdata scrape https://example.com --data-format markdown",
			description: "Get markdown, ideal for LLM input",
		},
		{
			command:
				"infer bdata scrape https://example.com --format json | jq '.status_code'",
			description: "Get a structured response and query it",
		},
		{
			command: "infer bdata scrape https://a.com https://b.com --concurrency 2",
			description: "Scrape several URLs in parallel",
		},
		{
			command: `infer bdata scrape https://example.com --input '{"dataFormat":"markdown","country":"gb"}'`,
			description: "Pass options as one JSON object instead of flags",
		},
	]),
);

// --- search ---------------------------------------------------------------

const searchCmd = Command.make(
	"search",
	{
		queries: Argument.string("query").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more search queries. Several queries are run in parallel and returned as an array, in the order given.",
			),
		),
		engine: Flag.choice("engine", SEARCH_ENGINES).pipe(
			Flag.optional,
			Flag.withDescription("Search engine to query. Defaults to google."),
		),
		language: Flag.string("language").pipe(
			Flag.withMetavar("code"),
			Flag.optional,
			Flag.withDescription(
				"Language code for the results, e.g. en or pt-BR. Two to five characters.",
			),
		),
		numResults: Flag.integer("num-results").pipe(
			Flag.withMetavar("1-100"),
			Flag.optional,
			Flag.withDescription("How many results to return. Defaults to 10."),
		),
		start: Flag.integer("start").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Result offset to start from, for paging. Defaults to 0.",
			),
		),
		...baseFlags,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const options = yield* resolveOptions(config.input, SEARCH_KEYS, {
				...baseOptions(config),
				language: Option.getOrUndefined(config.language),
				numResults: Option.getOrUndefined(config.numResults),
				start: Option.getOrUndefined(config.start),
			});
			const engine = Option.getOrElse(
				config.engine,
				() => "google" as SearchEngine,
			);
			const result = yield* bdata.search(engine, config.queries, options);
			yield* Console.log(renderResult(result));
		}),
).pipe(
	Command.withShortDescription("Search Google, Bing or Yandex."),
	Command.withDescription(
		`Run search engine queries through Bright Data.

Returns the search engine results page rather than a curated answer,
so --format json is usually what you want for anything programmatic.

Requires a Bright Data API key: run \`infer keys set\` or set
BRIGHTDATA_API_KEY.`,
	),
	Command.withExamples([
		{
			command: `infer bdata search "pizza restaurants"`,
			description: "Search Google",
		},
		{
			command: `infer bdata search "pizza" --engine bing --format json`,
			description: "Search Bing and get structured results",
		},
		{
			command: `infer bdata search "pizza" --country gb --num-results 20`,
			description: "Geo-target the search and widen it",
		},
		{
			command: `infer bdata search "pizza" "sushi" "tacos" --format json`,
			description: "Run several queries in parallel",
		},
	]),
);

export const bdataCmd = Command.make("bdata").pipe(
	Command.withShortDescription("Scrape the web and query search engines."),
	Command.withDescription(
		`Web scraping and search engine results via Bright Data.

Both subcommands accept several targets at once and process them in
parallel, and both take their options either as flags or as one JSON
object via --input.`,
	),
	Command.withSubcommands([scrapeCmd, searchCmd]),
);
