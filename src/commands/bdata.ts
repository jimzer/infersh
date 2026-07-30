/**
 * `infer bdata` — Bright Data web scraping and search.
 */

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
	Bdata,
	BdataError,
	DATA_FORMATS,
	discoverInput,
	FORMATS,
	METHODS,
	mergeOptions,
	parseInput,
	renderResult,
	SEARCH_ENGINES,
	type SearchEngine,
	videoInput,
	YOUTUBE_VIDEOS_DATASET,
} from "../bdata.ts";
import { emitJson, jsonFlag, wrapPayload } from "../output.ts";

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
	json: jsonFlag,
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
			if (config.json) {
				return yield* emitJson(wrapPayload(result, "content"));
			}
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
			if (config.json) {
				return yield* emitJson(wrapPayload(result, "content"));
			}
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

// --- youtube --------------------------------------------------------------

const videoCmd = Command.make(
	"video",
	{
		urls: Argument.string("url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more YouTube video URLs. All are collected in a single request.",
			),
		),
		country: Flag.string("country").pipe(
			Flag.withMetavar("cc"),
			Flag.optional,
			Flag.withDescription(
				"Two-letter country code to fetch from, affecting availability and localised fields.",
			),
		),
		transcriptionLanguage: Flag.string("transcription-language").pipe(
			Flag.withMetavar("lang"),
			Flag.optional,
			Flag.withDescription(
				"Language for the returned transcript, e.g. English. Omit to use the video's own.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const result = yield* bdata.datasetScrape(
				{ datasetId: YOUTUBE_VIDEOS_DATASET },
				videoInput(config.urls, {
					country: Option.getOrUndefined(config.country),
					transcriptionLanguage: Option.getOrUndefined(
						config.transcriptionLanguage,
					),
				}),
			);
			yield* Console.log(renderResult(result));
		}),
).pipe(
	Command.withShortDescription("Collect metadata for YouTube videos by URL."),
	Command.withDescription(
		`Collect full metadata for one or more YouTube videos.

Returns structured records with title, channel, view and like counts,
duration, publish date, description, tags, thumbnail, subscriber count
and the transcript.

Usually answers inline. Longer jobs are deferred to a snapshot, which
is then polled automatically; progress goes to stderr so stdout stays
pure JSON.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata youtube video https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			description: "Collect one video's metadata",
		},
		{
			command:
				"infer bdata youtube video https://youtu.be/a https://youtu.be/b | jq '.[].title'",
			description: "Collect several and pull out the titles",
		},
		{
			command:
				"infer bdata youtube video https://youtu.be/a --transcription-language English",
			description: "Request the transcript in a given language",
		},
	]),
);

const discoverCmd = Command.make(
	"discover",
	{
		keywords: Argument.string("keyword").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more search keywords. Each is discovered independently.",
			),
		),
		numOfPosts: Flag.integer("num-of-posts").pipe(
			Flag.withMetavar("n"),
			Flag.withDescription(
				"Required. Maximum videos to collect per keyword. Every collected video is billed, and the API treats an absent limit as unlimited, so this must be stated rather than defaulted.",
			),
		),
		startDate: Flag.string("start-date").pipe(
			Flag.withMetavar("date"),
			Flag.optional,
			Flag.withDescription(
				"Only include videos published on or after this date, e.g. 2026-01-01.",
			),
		),
		endDate: Flag.string("end-date").pipe(
			Flag.withMetavar("date"),
			Flag.optional,
			Flag.withDescription(
				"Only include videos published on or before this date.",
			),
		),
		country: Flag.string("country").pipe(
			Flag.withMetavar("cc"),
			Flag.optional,
			Flag.withDescription(
				"Two-letter country code to search from, changing which results are surfaced.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			if (config.numOfPosts < 1) {
				return yield* Effect.fail(
					new BdataError({
						reason: "--num-of-posts must be at least 1.",
					}),
				);
			}
			const result = yield* bdata.datasetScrape(
				{
					datasetId: YOUTUBE_VIDEOS_DATASET,
					type: "discover_new",
					discoverBy: "keyword",
					// Belt and braces: num_of_posts bounds each input row, and
					// limit_per_input bounds the job server-side, so a limit still
					// applies if either is ignored.
					limitPerInput: config.numOfPosts,
				},
				discoverInput(config.keywords, {
					numOfPosts: config.numOfPosts,
					startDate: Option.getOrUndefined(config.startDate),
					endDate: Option.getOrUndefined(config.endDate),
					country: Option.getOrUndefined(config.country),
				}),
			);
			yield* Console.log(renderResult(result));
		}),
).pipe(
	Command.withShortDescription("Find YouTube videos by keyword."),
	Command.withDescription(
		`Discover YouTube videos matching a keyword search.

Returns the same records as \`video\`, but found by searching rather
than by URL.

--num-of-posts is required. A keyword can match an unbounded number of
videos and every one is billed, so the limit has to be stated rather
than defaulted. It is enforced twice: per input row and again as a
server-side cap on the job.

Discovery is queued rather than answered inline: the job is polled
every 10 seconds for up to 10 minutes, with progress on stderr.`,
	),
	Command.withExamples([
		{
			command: `infer bdata youtube discover "artificial intelligence tools" --num-of-posts 20`,
			description: "Find 20 videos for a keyword",
		},
		{
			command: `infer bdata youtube discover "effect ts" --start-date 2026-01-01 --num-of-posts 50`,
			description: "Restrict discovery to recent videos",
		},
		{
			command: `infer bdata youtube discover "pizza" "sushi" --num-of-posts 10 | jq '.[].url'`,
			description: "Discover for several keywords and list the URLs",
		},
	]),
);

const youtubeCmd = Command.make("youtube").pipe(
	Command.withShortDescription("Collect and discover YouTube videos."),
	Command.withDescription(
		`YouTube data via Bright Data's Web Scraper API.

\`video\` collects known URLs; \`discover\` finds videos by keyword. Both
return the same record shape, so their output is interchangeable.`,
	),
	Command.withSubcommands([videoCmd, discoverCmd]),
);

export const bdataCmd = Command.make("bdata").pipe(
	Command.withShortDescription("Scrape the web and query search engines."),
	Command.withDescription(
		`Web scraping and search engine results via Bright Data.

Both subcommands accept several targets at once and process them in
parallel, and both take their options either as flags or as one JSON
object via --input.`,
	),
	Command.withSubcommands([scrapeCmd, searchCmd, youtubeCmd]),
);
