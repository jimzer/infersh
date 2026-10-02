/**
 * `infer bdata` — Bright Data web scraping and search.
 */

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
	Bdata,
	BdataError,
	CHATGPT_DATASET,
	chatgptInput,
	DATA_FORMATS,
	DATASETS,
	discoverInput,
	FORMATS,
	LINKEDIN_COMPANIES_DATASET,
	LINKEDIN_JOBS_DATASET,
	LINKEDIN_POSTS_DATASET,
	LINKEDIN_PROFILES_DATASET,
	linkedinJobsInput,
	linkedinPostsInput,
	linkedinUrlKind,
	METHODS,
	mergeOptions,
	parseInput,
	REDDIT_COMMENTS_DATASET,
	REDDIT_DATES,
	REDDIT_POSTS_DATASET,
	REDDIT_SORTS,
	redditCommentsInput,
	redditKeywordInput,
	redditSubredditInput,
	renderResult,
	resolveDataset,
	SEARCH_ENGINES,
	type SearchEngine,
	SNAPSHOT_STATUSES,
	urlInput,
	videoInput,
	X_POSTS_DATASET,
	xProfileInput,
	YOUTUBE_COMMENTS_DATASET,
	YOUTUBE_VIDEOS_DATASET,
} from "../bdata.ts";
import {
	CHATGPT_ANSWER,
	compactRecords,
	compactSerp,
	LINKEDIN_JOB,
	LINKEDIN_POST,
	missingFields,
	parseFields,
	projectFields,
	REDDIT_COMMENT,
	REDDIT_POST,
	SEARCH_RESULT_SUMMARY,
	type Shape,
	X_POST,
	YOUTUBE_COMMENT,
	YOUTUBE_VIDEO,
} from "../listing.ts";
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
	format: Flag.Literals("format", FORMATS).pipe(
		Flag.optional,
		Flag.withDescription(
			"raw (default) returns the page or results as text; json returns a structured object worth piping into jq.",
		),
	),
	dataFormat: Flag.Literals("data-format", DATA_FORMATS).pipe(
		Flag.optional,
		Flag.withDescription(
			"Shape of the returned content: html (default), markdown (md is an alias) for LLM-friendly text, or screenshot for a PNG.",
		),
	),
	country: Flag.String("country").pipe(
		Flag.withMetavar("cc"),
		Flag.optional,
		Flag.withDescription(
			"Two-letter ISO 3166-1 country code to route the request through, e.g. gb or us. Changes geo-targeted results.",
		),
	),
	method: Flag.Literals("method", METHODS).pipe(
		Flag.optional,
		Flag.withDescription("HTTP method for the request. Defaults to GET."),
	),
	zone: Flag.String("zone").pipe(
		Flag.withMetavar("name"),
		Flag.optional,
		Flag.withDescription(
			"Bright Data zone to bill against. Created automatically when omitted.",
		),
	),
	concurrency: Flag.Int("concurrency").pipe(
		Flag.withMetavar("1-50"),
		Flag.optional,
		Flag.withDescription(
			"How many of a batch to process in parallel. Defaults to 10; only matters when passing several targets.",
		),
	),
	timeout: Flag.Int("timeout").pipe(
		Flag.withMetavar("ms"),
		Flag.optional,
		Flag.withDescription(
			"Per-request timeout in milliseconds, between 250 and 300000. Defaults to 120000.",
		),
	),
	input: Flag.String("input").pipe(
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

/**
 * Every discovery route below is unbounded without this.
 *
 * A profile or a subreddit has no natural end and each collected record is
 * billed, so the cap is required rather than defaulted (`docs/adrs/0011`).
 */
const limitFlag = Flag.Int("limit").pipe(
	Flag.withMetavar("n"),
	Flag.withDescription(
		"Required. Maximum records to collect per input. Discovery is otherwise unbounded and every record is billed, so the cap has to be stated rather than defaulted.",
	),
);

const dateWindowFlags = {
	startDate: Flag.String("start-date").pipe(
		Flag.withMetavar("date"),
		Flag.optional,
		Flag.withDescription(
			"Only include posts published on or after this date, e.g. 2026-08-01.",
		),
	),
	endDate: Flag.String("end-date").pipe(
		Flag.withMetavar("date"),
		Flag.optional,
		Flag.withDescription(
			"Only include posts published on or before this date.",
		),
	),
};

const requirePositive = (limit: number, flag: string) =>
	limit < 1
		? Effect.fail(new BdataError({ reason: `${flag} must be at least 1.` }))
		: Effect.void;

// --- output shapes ----------------------------------------------------------
//
// Listing commands print a compact record per result by default, and the
// provider's full record with --raw. Commands that collect known URLs print
// the full record by default, and the compact one with --compact. --fields
// works on whichever is printed. See docs/adrs/0029.

const fieldsFlag = Flag.String("fields").pipe(
	Flag.withMetavar("a,b,c"),
	Flag.optional,
	// An empty --fields "" selects nothing, so it is treated as absent.
	Flag.map(
		Option.flatMap((text) =>
			Option.liftPredicate(parseFields(text), (fields) => fields.length > 0),
		),
	),
	Flag.withDescription(
		"Keep only these keys of each result, comma-separated, e.g. --fields title,url. Applies to whichever shape is printed: the compact one, or Bright Data's own keys with --raw. A dotted path reaches into nested objects and arrays, e.g. citations.url. A failed row keeps its error field. A key no result has is reported on stderr with the keys that do exist. Pipe to jq for anything more complex.",
	),
);

const rawFlag = Flag.Boolean("raw").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Print Bright Data's full record for each result instead of the compact shape: every field the provider returns, under its own snake_case names, from a few to over a thousand times larger. Use it when the field you need is not in the compact shape, ideally with --fields.",
	),
);

const compactFlag = Flag.Boolean("compact").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Print the compact shape shown above instead of Bright Data's full record. The same shape the discovery command prints by default.",
	),
);

/** The help paragraph for a command that prints compact records by default. */
const compactNote = (one: string, shape: Shape) =>
	`Prints one compact record per ${one}:

  ${shape.summary}

A field the provider has no value for is left out rather than null. A
row that could not be collected is {error, errorCode, input}. --raw
prints Bright Data's full record instead; --fields keeps only the keys
you name, of either shape.`;

/** The help paragraph for a command that prints the full record by default. */
const rawNote = (shape: Shape) =>
	`Prints Bright Data's full record. --compact prints just

  ${shape.summary}

and --fields keeps only the keys you name, of either shape.`;

/** Applies --fields, warning on stderr about keys no result has. */
const selectFields = (
	value: unknown,
	fields: Option.Option<ReadonlyArray<string>>,
): Effect.Effect<unknown> =>
	Option.match(fields, {
		onNone: () => Effect.succeed(value),
		onSome: (fields) =>
			Effect.gen(function* () {
				const { missing, available } = missingFields(value, fields);
				if (missing.length > 0) {
					yield* Console.error(
						`--fields: no result has ${missing.join(", ")}. Keys here: ${available.join(", ")}`,
					);
				}
				return projectFields(value, fields);
			}),
	});

/** Prints dataset rows, compacted when asked and projected by --fields. */
const emitRecords = (
	result: unknown,
	options: {
		readonly shape?: Shape;
		readonly compact: boolean;
		readonly fields: Option.Option<ReadonlyArray<string>>;
	},
) =>
	Effect.gen(function* () {
		const shaped =
			options.compact && options.shape
				? compactRecords(options.shape, result)
				: result;
		yield* Console.log(
			renderResult(yield* selectFields(shaped, options.fields)),
		);
	});

// --- scrape ---------------------------------------------------------------

const scrapeCmd = Command.make(
	"scrape",
	{
		urls: Argument.String("url").pipe(
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
		queries: Argument.String("query").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more search queries. Several queries are run in parallel and returned as an array, in the order given.",
			),
		),
		engine: Flag.Literals("engine", SEARCH_ENGINES).pipe(
			Flag.optional,
			Flag.withDescription("Search engine to query. Defaults to google."),
		),
		language: Flag.String("language").pipe(
			Flag.withMetavar("code"),
			Flag.optional,
			Flag.withDescription(
				"Language code for the results, e.g. en or pt-BR. Two to five characters.",
			),
		),
		numResults: Flag.Int("num-results").pipe(
			Flag.withMetavar("1-100"),
			Flag.optional,
			Flag.withDescription("How many results to return. Defaults to 10."),
		),
		start: Flag.Int("start").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Result offset to start from, for paging. Defaults to 0.",
			),
		),
		raw: Flag.Boolean("raw").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Print Bright Data's whole parsed results page instead of [{title, url, snippet, date}]: organic results under its own names (link, description), plus related searches, pagination and any panels. --fields then picks its top-level keys, or dotted paths such as organic.link.",
			),
		),
		fields: fieldsFlag,
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

			if (!config.raw) {
				// One result for one query, an array for several — see runAll.
				const pages =
					config.queries.length === 1 || !Array.isArray(result)
						? [result]
						: result;
				const compacted = Option.all(pages.map(compactSerp));
				if (Option.isSome(compacted)) {
					const [first] = compacted.value;
					if (config.queries.length === 1 && first !== undefined) {
						return yield* Console.log(
							renderResult(yield* selectFields(first, config.fields)),
						);
					}
					const grouped: Array<unknown> = [];
					for (const [index, results] of compacted.value.entries()) {
						grouped.push({
							query: config.queries[index],
							results: yield* selectFields(results, config.fields),
						});
					}
					return yield* Console.log(renderResult(grouped));
				}
				yield* Console.error(
					"Not a parsed Google results page (Bing, Yandex, a --data-format, or an error from Bright Data), so it is printed as returned.",
				);
			}

			const selected =
				typeof result === "string"
					? result
					: yield* selectFields(result, config.fields);
			if (config.json) {
				return yield* emitJson(wrapPayload(selected, "content"));
			}
			yield* Console.log(renderResult(selected));
		}),
).pipe(
	Command.withShortDescription("Search Google, Bing or Yandex."),
	Command.withDescription(
		`Run search engine queries through Bright Data.

On Google (the default), prints the organic results, one compact
record each:

  ${SEARCH_RESULT_SUMMARY}

date is the one Google shows under a result, as it shows it ("23 Mar
2026", "3 days ago"), and is left out when there is none. Several
queries print [{query, results}], in the order given. --fields keeps
only the keys you name.

--raw prints Bright Data's whole parsed results page instead —
organic results under its own names (link, description), plus related
searches, pagination and whatever panels Google showed. Bing and Yandex
are not parsed, so they always print the page as returned.

Requires a Bright Data API key: run \`infer keys set\` or set
BRIGHTDATA_API_KEY.`,
	),
	Command.withExamples([
		{
			command: `infer bdata search "pizza restaurants"`,
			description: "Search Google: [{title, url, snippet, date}]",
		},
		{
			command: `infer bdata search "effect typescript" --fields url`,
			description: "Just the result URLs",
		},
		{
			command: `infer bdata search "pizza" --raw | jq '.related'`,
			description: "Everything Google returned, including related searches",
		},
		{
			command: `infer bdata search "pizza" --engine bing`,
			description: "Search Bing (printed as returned)",
		},
		{
			command: `infer bdata search "pizza" --country gb --num-results 20`,
			description: "Geo-target the search and widen it",
		},
		{
			command: `infer bdata search "pizza" "sushi" "tacos"`,
			description: "Run several queries in parallel: [{query, results}]",
		},
	]),
);

// --- youtube --------------------------------------------------------------

const videoCmd = Command.make(
	"video",
	{
		urls: Argument.String("url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more YouTube video URLs. All are collected in a single request.",
			),
		),
		country: Flag.String("country").pipe(
			Flag.withMetavar("cc"),
			Flag.optional,
			Flag.withDescription(
				"Two-letter country code to fetch from, affecting availability and localised fields.",
			),
		),
		transcriptionLanguage: Flag.String("transcription-language").pipe(
			Flag.withMetavar("lang"),
			Flag.optional,
			Flag.withDescription(
				"Language for the returned transcript, e.g. English. Omit to use the video's own.",
			),
		),
		compact: compactFlag,
		fields: fieldsFlag,
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
			yield* emitRecords(result, {
				shape: YOUTUBE_VIDEO,
				compact: config.compact,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Collect metadata for YouTube videos by URL."),
	Command.withDescription(
		`Collect full metadata for one or more YouTube videos.

Returns structured records with title, channel, view and like counts,
duration, publish date, description, tags, thumbnail, subscriber count
and the transcript — about 80 KB per video, most of it the transcript
twice over (transcript and formatted_transcript).

${rawNote(YOUTUBE_VIDEO)}

--fields title,transcript is the cheap way to read what a video says.

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
				"infer bdata youtube video https://youtu.be/a https://youtu.be/b --compact",
			description: "Several videos, compact: title, channel, views, ...",
		},
		{
			command:
				"infer bdata youtube video https://youtu.be/a --fields title,transcript",
			description: "Just what the video says",
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
		keywords: Argument.String("keyword").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more search keywords. Each is discovered independently.",
			),
		),
		numOfPosts: Flag.Int("num-of-posts").pipe(
			Flag.withMetavar("n"),
			Flag.withDescription(
				"Required. Maximum videos to collect per keyword. Every collected video is billed, and the API treats an absent limit as unlimited, so this must be stated rather than defaulted.",
			),
		),
		startDate: Flag.String("start-date").pipe(
			Flag.withMetavar("date"),
			Flag.optional,
			Flag.withDescription(
				"Only include videos published on or after this date, e.g. 2026-01-01.",
			),
		),
		endDate: Flag.String("end-date").pipe(
			Flag.withMetavar("date"),
			Flag.optional,
			Flag.withDescription(
				"Only include videos published on or before this date.",
			),
		),
		country: Flag.String("country").pipe(
			Flag.withMetavar("cc"),
			Flag.optional,
			Flag.withDescription(
				"Two-letter country code to search from, changing which results are surfaced.",
			),
		),
		raw: rawFlag,
		fields: fieldsFlag,
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
			yield* emitRecords(result, {
				shape: YOUTUBE_VIDEO,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Find YouTube videos by keyword."),
	Command.withDescription(
		`Discover YouTube videos matching a keyword search.

Finds the same records as \`video\`, by searching rather than by URL.
${compactNote("video", YOUTUBE_VIDEO)}

duration is in seconds. The transcript, description and tags are in
--raw.

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
			command: `infer bdata youtube discover "pizza" "sushi" --num-of-posts 10 --fields url`,
			description: "Discover for several keywords and list the URLs",
		},
	]),
);

// --- youtube comments ------------------------------------------------------

const youtubeCommentsCmd = Command.make(
	"comments",
	{
		urls: Argument.String("video-url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more YouTube video URLs whose comments should be collected.",
			),
		),
		limit: limitFlag,
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* requirePositive(config.limit, "--limit");
			const result = yield* bdata.datasetScrape(
				{ datasetId: YOUTUBE_COMMENTS_DATASET, limitPerInput: config.limit },
				urlInput(config.urls),
			);
			yield* emitRecords(result, {
				shape: YOUTUBE_COMMENT,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Collect the comments under a YouTube video."),
	Command.withDescription(
		`Collect comments from one or more YouTube videos.

A different dataset from \`video\`, with its own shape.
${compactNote("comment", YOUTUBE_COMMENT)}

\`video\` already returns the transcript, so use this when you want the
audience's reaction rather than the content itself.

--limit is required even though the URL is known. A popular video holds
tens of thousands of comments and each is billed.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata youtube comments https://youtu.be/dQw4w9WgXcQ --limit 100",
			description: "The first 100 comments on a video",
		},
	]),
);

const youtubeCmd = Command.make("youtube").pipe(
	Command.withShortDescription("Collect and discover YouTube videos."),
	Command.withDescription(
		`YouTube data via Bright Data's Web Scraper API.

\`video\` collects known URLs; \`discover\` finds videos by keyword. Both
collect the same record: \`discover\` prints it compact unless --raw,
\`video\` prints it whole unless --compact.`,
	),
	Command.withSubcommands([videoCmd, discoverCmd, youtubeCommentsCmd]),
);

// --- x and reddit ----------------------------------------------------------

const xPostCmd = Command.make(
	"post",
	{
		urls: Argument.String("url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more X post URLs, e.g. https://x.com/OpenAI/status/123. All are collected in a single request.",
			),
		),
		compact: compactFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const result = yield* bdata.datasetScrape(
				{ datasetId: X_POSTS_DATASET },
				urlInput(config.urls),
			);
			yield* emitRecords(result, {
				shape: X_POST,
				compact: config.compact,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Collect X posts by URL."),
	Command.withDescription(
		`Collect full records for one or more X (Twitter) posts.

Returns the post text and date, engagement counts (replies, reposts,
likes, views), attached photos and videos, hashtags and tagged users,
plus the author's follower count, biography and verification status.

${rawNote(X_POST)}

No limit flag: the number of URLs you pass is the limit.

A post that does not exist comes back as a row with an \`error\` field
rather than failing the call, so check for it before treating a result
as content.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata x post https://x.com/OpenAI/status/2085434718393418101",
			description: "Collect one post",
		},
		{
			command:
				"infer bdata x post https://x.com/a/status/1 https://x.com/b/status/2 --fields url,likes",
			description: "Collect several and pull out engagement",
		},
	]),
);

const xProfileCmd = Command.make(
	"profile",
	{
		urls: Argument.String("profile-url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more X profile URLs, e.g. https://x.com/OpenAI. Each is discovered separately, so --limit applies to each.",
			),
		),
		limit: limitFlag,
		...dateWindowFlags,
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* requirePositive(config.limit, "--limit");
			const result = yield* bdata.datasetScrape(
				{
					datasetId: X_POSTS_DATASET,
					type: "discover_new",
					discoverBy: "profile_url",
					limitPerInput: config.limit,
				},
				xProfileInput(config.urls, {
					startDate: Option.getOrUndefined(config.startDate),
					endDate: Option.getOrUndefined(config.endDate),
				}),
			);
			yield* emitRecords(result, {
				shape: X_POST,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Find recent X posts from profiles."),
	Command.withDescription(
		`Discover recent posts from one or more X profiles.

Finds the same records as \`post\`, by walking each profile rather
than by URL. This is the reliable way to monitor accounts:
Bright Data has no keyword search for X, so a topic search has to go
through \`infer bdata search 'site:x.com ... after:...'\` instead.

--limit applies per profile, so three profiles at --limit 10 collect up
to 30 records. Pass every account you want in one call rather than
running the command repeatedly.

${compactNote("post", X_POST)}`,
	),
	Command.withExamples([
		{
			command: "infer bdata x profile https://x.com/OpenAI --limit 10",
			description: "Latest 10 posts from one account",
		},
		{
			command:
				"infer bdata x profile https://x.com/OpenAI https://x.com/AnthropicAI --limit 5",
			description: "Up to 5 each from two accounts",
		},
		{
			command:
				"infer bdata x profile https://x.com/OpenAI --limit 20 --start-date 2026-08-01",
			description: "Only posts from August onwards",
		},
	]),
);

const xCmd = Command.make("x").pipe(
	Command.withShortDescription("Collect and discover X (Twitter) posts."),
	Command.withDescription(
		`X (Twitter) data via Bright Data's Web Scraper API.

\`post\` collects known URLs; \`profile\` finds posts by account. Both
collect the same record: \`profile\` prints it compact unless --raw,
\`post\` prints it whole unless --compact.

There is no keyword search for X here — Bright Data does not offer one.
To find posts about a topic, search Google instead:

  infer bdata search 'site:x.com effect after:2026-08-01'

then feed the /status/ URLs it returns into \`x post\`.`,
	),
	Command.withSubcommands([xPostCmd, xProfileCmd]),
);

const redditPostCmd = Command.make(
	"post",
	{
		urls: Argument.String("url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more Reddit post URLs. All are collected in a single request.",
			),
		),
		compact: compactFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const result = yield* bdata.datasetScrape(
				{ datasetId: REDDIT_POSTS_DATASET },
				urlInput(config.urls),
			);
			yield* emitRecords(result, {
				shape: REDDIT_POST,
				compact: config.compact,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Collect Reddit posts by URL."),
	Command.withDescription(
		`Collect full records for one or more Reddit posts.

Returns the title and body, score and comment count, author, date, and
the community's name, description, member count and rank.

Reddit blocks ordinary fetching, so this is the route to a post's
content — do not try WebFetch first.

${rawNote(REDDIT_POST)}

A deleted or missing post comes back as a row with an \`error\` field
rather than failing the call.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata reddit post https://www.reddit.com/r/typescript/comments/abc123/title/",
			description: "Collect one post",
		},
	]),
);

const redditCommentsCmd = Command.make(
	"comments",
	{
		urls: Argument.String("post-url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more Reddit post URLs whose comments should be collected.",
			),
		),
		limit: limitFlag,
		daysBack: Flag.Int("days-back").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Only include comments from the last n days. Narrows a long thread by age rather than by count.",
			),
		),
		sort: Flag.Literals("sort", REDDIT_SORTS).pipe(
			Flag.optional,
			Flag.withDescription(
				"Comment ordering. Which comments --limit keeps depends on this.",
			),
		),
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* requirePositive(config.limit, "--limit");
			const result = yield* bdata.datasetScrape(
				{
					datasetId: REDDIT_COMMENTS_DATASET,
					limitPerInput: config.limit,
				},
				redditCommentsInput(config.urls, {
					daysBack: Option.getOrUndefined(config.daysBack),
					sortBy: Option.getOrUndefined(config.sort),
				}),
			);
			yield* emitRecords(result, {
				shape: REDDIT_COMMENT,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Collect the comments under a Reddit post."),
	Command.withDescription(
		`Collect comments from one or more Reddit posts.

This is a different dataset from \`post\`, with its own record shape.
${compactNote("comment", REDDIT_COMMENT)}

replies is a count; the nested replies themselves are in --raw.

--limit is required even though the URLs are known. A busy thread holds
thousands of comments and each one is billed, so the count has to be
stated. Combine with --sort to choose which ones you get.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata reddit comments https://www.reddit.com/r/typescript/comments/abc123/t/ --limit 50",
			description: "The 50 comments the default ordering surfaces",
		},
		{
			command:
				"infer bdata reddit comments https://reddit.com/r/x/comments/y/z/ --limit 20 --sort Top",
			description: "The 20 highest-scoring comments",
		},
	]),
);

const redditSearchCmd = Command.make(
	"search",
	{
		keywords: Argument.String("keyword").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more search keywords. Each is discovered independently.",
			),
		),
		numOfPosts: Flag.Int("num-of-posts").pipe(
			Flag.withMetavar("n"),
			Flag.withDescription(
				"Required. Maximum posts to collect per keyword. Every collected post is billed and an absent limit means unlimited, so this must be stated.",
			),
		),
		date: Flag.Literals("date", REDDIT_DATES).pipe(
			Flag.optional,
			Flag.withDescription(
				"How far back to search. Omit to let Reddit choose its default window.",
			),
		),
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* requirePositive(config.numOfPosts, "--num-of-posts");
			const result = yield* bdata.datasetScrape(
				{
					datasetId: REDDIT_POSTS_DATASET,
					type: "discover_new",
					discoverBy: "keyword",
					limitPerInput: config.numOfPosts,
				},
				redditKeywordInput(config.keywords, {
					numOfPosts: config.numOfPosts,
					date: Option.getOrUndefined(config.date),
				}),
			);
			yield* emitRecords(result, {
				shape: REDDIT_POST,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Find Reddit posts by keyword."),
	Command.withDescription(
		`Search Reddit for posts matching a keyword.

Finds the same records as \`post\`, by searching rather than by URL.
Unlike X, Reddit does support keyword search here, so this is the
direct route to "what is being said about X".

--num-of-posts is required and is enforced twice: per keyword, and again
as a server-side cap on the job.

${compactNote("post", REDDIT_POST)}

text is the body, absent on a link post.`,
	),
	Command.withExamples([
		{
			command: `infer bdata reddit search "effect typescript" --num-of-posts 20`,
			description: "Find 20 posts for a keyword",
		},
		{
			command: `infer bdata reddit search "rust vs go" --num-of-posts 10 --date "Past week"`,
			description: "Restrict to the last week",
		},
	]),
);

const redditSubredditCmd = Command.make(
	"subreddit",
	{
		urls: Argument.String("subreddit-url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more subreddit URLs, e.g. https://www.reddit.com/r/typescript/.",
			),
		),
		limit: limitFlag,
		sort: Flag.Literals("sort", REDDIT_SORTS).pipe(
			Flag.optional,
			Flag.withDescription(
				"Which listing to read: Hot, New, Top or Rising. Decides which posts --limit keeps.",
			),
		),
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* requirePositive(config.limit, "--limit");
			const result = yield* bdata.datasetScrape(
				{
					datasetId: REDDIT_POSTS_DATASET,
					type: "discover_new",
					discoverBy: "subreddit_url",
					limitPerInput: config.limit,
				},
				redditSubredditInput(config.urls, {
					sortBy: Option.getOrUndefined(config.sort),
				}),
			);
			yield* emitRecords(result, {
				shape: REDDIT_POST,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Read a subreddit's posts."),
	Command.withDescription(
		`Discover posts from one or more subreddits.

Finds the same records as \`post\`. --sort chooses the listing, and it
is the difference between "what is popular now" (Hot), "what is new"
(New) and "what did best over time" (Top).

--limit applies per subreddit.

The sort values are capitalised. The published docs list \`new\`, \`top\`
and \`hot\`; the API rejects all three.

${compactNote("post", REDDIT_POST)}`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata reddit subreddit https://www.reddit.com/r/typescript/ --limit 25 --sort Hot",
			description: "The 25 hottest posts right now",
		},
		{
			command:
				"infer bdata reddit subreddit https://www.reddit.com/r/rust/ --limit 10 --sort New --fields url",
			description: "The 10 newest posts, as URLs",
		},
	]),
);

const redditCmd = Command.make("reddit").pipe(
	Command.withShortDescription(
		"Collect and discover Reddit posts and comments.",
	),
	Command.withDescription(
		`Reddit data via Bright Data's Web Scraper API.

\`post\`, \`search\` and \`subreddit\` all return post records; \`comments\`
returns a different shape, one row per comment. Every command but
\`post\` prints compact records unless --raw.

The usual pipeline is discovery then depth: find posts with \`search\` or
\`subreddit\`, then pass the URLs you care about to \`comments\`, where the
actual discussion is.`,
	),
	Command.withSubcommands([
		redditPostCmd,
		redditCommentsCmd,
		redditSearchCmd,
		redditSubredditCmd,
	]),
);

// --- chatgpt ---------------------------------------------------------------

const chatgptCmd = Command.make(
	"chatgpt",
	{
		prompts: Argument.String("prompt").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more prompts, up to 4096 characters each. Every prompt is asked independently.",
			),
		),
		country: Flag.String("country").pipe(
			Flag.withMetavar("cc"),
			Flag.optional,
			Flag.withDescription(
				"Two-letter country code to ask from. Answers differ by market, so this is how you compare them.",
			),
		),
		followUp: Flag.String("follow-up").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				"A clarifying question asked after the first answer, in the same conversation.",
			),
		),
		noWebSearch: Flag.Boolean("no-web-search").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Answer from the model alone. Web search is on by default, and is what produces citations.",
			),
		),
		requireSources: Flag.Boolean("require-sources").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Fail the row rather than return an answer with no sources. Worth setting when you intend to fetch the citations.",
			),
		),
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const result = yield* bdata.datasetScrape(
				{ datasetId: CHATGPT_DATASET },
				chatgptInput(config.prompts, {
					country: Option.getOrUndefined(config.country),
					additionalPrompt: Option.getOrUndefined(config.followUp),
					webSearch: config.noWebSearch ? false : undefined,
					requireSources: config.requireSources,
				}),
			);
			yield* emitRecords(result, {
				shape: CHATGPT_ANSWER,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription(
		"Ask ChatGPT and get its answer with citations.",
	),
	Command.withDescription(
		`Ask ChatGPT a question and get the answer back as data.

${compactNote("prompt", CHATGPT_ANSWER)}

answer is the markdown answer. followUp and followUpAnswer appear only
with --follow-up. The raw record is mostly answer_html, the whole
ChatGPT page — around 750 KB for a one-sentence answer.

Billed per prompt rather than per token, so the cost of a question does
not depend on how long the answer turns out to be.

Two things it is good for. As a research step, the citations are a
ranked reading list: pass them to \`bdata scrape\` to get the actual
pages. As a monitoring step, it answers "what does ChatGPT say about
us", and --country makes that comparable across markets.

Web search is on by default and is what produces citations; add
--no-web-search to see what the model says unaided.`,
	),
	Command.withExamples([
		{
			command: `infer bdata chatgpt "What are the best TypeScript effect libraries in 2026?"`,
			description: "Ask a question and get sources",
		},
		{
			command: `infer bdata chatgpt "best CRM for small teams" --country de`,
			description: "See what a German user would be told",
		},
		{
			command: `infer bdata chatgpt "who makes the best AI CLI?" --fields citations.url`,
			description: "Turn one question into a reading list",
		},
	]),
);

// --- linkedin --------------------------------------------------------------

const linkedinCompanyCmd = Command.make(
	"company",
	{
		urls: Argument.String("company-url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more LinkedIn company URLs, e.g. https://www.linkedin.com/company/bright-data.",
			),
		),
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const result = yield* bdata.datasetScrape(
				{ datasetId: LINKEDIN_COMPANIES_DATASET },
				urlInput(config.urls),
			);
			yield* emitRecords(result, { compact: false, fields: config.fields });
		}),
).pipe(
	Command.withShortDescription("Collect LinkedIn company records."),
	Command.withDescription(
		`Collect full records for one or more LinkedIn companies.

Returns headcount, follower count, headquarters and other locations,
founding year, industries, specialties, website, the about text, and
where LinkedIn has it, funding rounds, investors, similar companies and
affiliated pages.

No limit flag: the number of URLs you pass is the limit. --fields keeps
only the keys you name, under Bright Data's own names.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata linkedin company https://www.linkedin.com/company/anthropicresearch",
			description: "Profile one company",
		},
	]),
);

const linkedinProfileCmd = Command.make(
	"profile",
	{
		urls: Argument.String("profile-url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more LinkedIn people URLs, e.g. https://www.linkedin.com/in/username.",
			),
		),
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const result = yield* bdata.datasetScrape(
				{ datasetId: LINKEDIN_PROFILES_DATASET },
				urlInput(config.urls),
			);
			yield* emitRecords(result, { compact: false, fields: config.fields });
		}),
).pipe(
	Command.withShortDescription("Collect LinkedIn people profiles."),
	Command.withDescription(
		`Collect full records for one or more LinkedIn people.

Returns current position and company, the full experience and education
history, skills, certifications, languages, connection and follower
counts, and the about text. --fields keeps only the keys you name,
under Bright Data's own names.

This is personal data. Collect what a question actually needs rather
than sweeping profiles up, and mind the obligations that come with
storing it.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata linkedin profile https://www.linkedin.com/in/some-user",
			description: "Collect one profile",
		},
	]),
);

const linkedinPostsCmd = Command.make(
	"posts",
	{
		urls: Argument.String("url").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"LinkedIn company URLs (/company/...) or people URLs (/in/...). All must be the same kind, since each uses a different discovery route.",
			),
		),
		limit: limitFlag,
		...dateWindowFlags,
		authoredOnly: Flag.Boolean("authored-only").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"People URLs only: drop reshares, keeping what the person actually wrote.",
			),
		),
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* requirePositive(config.limit, "--limit");

			const kinds = new Set(config.urls.map(linkedinUrlKind));
			if (kinds.has(null)) {
				return yield* Effect.fail(
					new BdataError({
						reason:
							"Every URL must be a LinkedIn company URL (/company/) or people URL (/in/).",
					}),
				);
			}
			if (kinds.size > 1) {
				return yield* Effect.fail(
					new BdataError({
						reason:
							"Company and people URLs use different discovery routes, so they cannot be mixed.\nRun the command once for each kind.",
					}),
				);
			}
			const kind = linkedinUrlKind(config.urls[0] as string);

			const result = yield* bdata.datasetScrape(
				{
					datasetId: LINKEDIN_POSTS_DATASET,
					type: "discover_new",
					discoverBy: kind === "company" ? "company_url" : "profile_url",
					limitPerInput: config.limit,
				},
				linkedinPostsInput(config.urls, {
					startDate: Option.getOrUndefined(config.startDate),
					endDate: Option.getOrUndefined(config.endDate),
					authoredOnly: config.authoredOnly,
				}),
			);
			yield* emitRecords(result, {
				shape: LINKEDIN_POST,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Find LinkedIn posts from companies or people."),
	Command.withDescription(
		`Discover posts from LinkedIn companies or people.

The route is chosen from the URL: /company/ pages are discovered one
way, /in/ people another. Both cannot be mixed in one call, and passing
something that is neither is an error rather than an empty result.

${compactNote("post", LINKEDIN_POST)}

The raw record adds hashtags, tagged companies and people, embedded
links, media, the top visible comments and the reposted post.

--limit applies per URL. --start-date and --end-date take ISO
timestamps. --authored-only drops reshares on the people route, which
is usually what you want when judging what someone actually thinks.`,
	),
	Command.withExamples([
		{
			command:
				"infer bdata linkedin posts https://www.linkedin.com/company/openai --limit 20",
			description: "A company's last 20 posts",
		},
		{
			command:
				"infer bdata linkedin posts https://www.linkedin.com/in/some-user --limit 10 --authored-only",
			description: "What one person wrote, excluding reshares",
		},
	]),
);

const linkedinJobsCmd = Command.make(
	"jobs",
	{
		location: Flag.String("location").pipe(
			Flag.withMetavar("place"),
			Flag.withDescription(
				"Required. Where to search, e.g. Berlin or United States. The API requires a place even when a keyword is given.",
			),
		),
		limit: limitFlag,
		keyword: Flag.String("keyword").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				'Job title or role. Quote a phrase for an exact match, e.g. "staff engineer".',
			),
		),
		country: Flag.String("country").pipe(
			Flag.withMetavar("cc"),
			Flag.optional,
			Flag.withDescription("Two-letter country code, e.g. US or FR."),
		),
		timeRange: Flag.String("time-range").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				'How recently posted, e.g. "Past month" or "Past week".',
			),
		),
		jobType: Flag.String("job-type").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription('Employment type, e.g. "Full-time" or "Contract".'),
		),
		experienceLevel: Flag.String("experience-level").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				'Career stage, e.g. "Entry level", "Mid-Senior level" or "Executive".',
			),
		),
		remote: Flag.String("remote").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription("Work arrangement: Remote, On-site or Hybrid."),
		),
		company: Flag.String("company").pipe(
			Flag.withMetavar("name"),
			Flag.optional,
			Flag.withDescription("Restrict to one employer."),
		),
		raw: rawFlag,
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* requirePositive(config.limit, "--limit");
			const result = yield* bdata.datasetScrape(
				{
					datasetId: LINKEDIN_JOBS_DATASET,
					type: "discover_new",
					discoverBy: "keyword",
					limitPerInput: config.limit,
				},
				linkedinJobsInput({
					location: config.location,
					keyword: Option.getOrUndefined(config.keyword),
					country: Option.getOrUndefined(config.country),
					timeRange: Option.getOrUndefined(config.timeRange),
					jobType: Option.getOrUndefined(config.jobType),
					experienceLevel: Option.getOrUndefined(config.experienceLevel),
					remote: Option.getOrUndefined(config.remote),
					company: Option.getOrUndefined(config.company),
				}),
			);
			yield* emitRecords(result, {
				shape: LINKEDIN_JOB,
				compact: !config.raw,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Search LinkedIn job postings."),
	Command.withDescription(
		`Search LinkedIn job postings.

${compactNote("job", LINKEDIN_JOB)}

salary appears where the posting publishes one. The full description
(job_summary, several KB each) and the apply link are in --raw.

--location is required, not --keyword: searching a place without a role
is valid, a role without a place is not.

What a company is hiring for is a read on what it is building, often
months before anything ships. --company plus a broad --keyword is the
competitive-intelligence shape of this command.`,
	),
	Command.withExamples([
		{
			command: `infer bdata linkedin jobs --location "San Francisco" --keyword "machine learning" --limit 25`,
			description: "Roles for a keyword in one city",
		},
		{
			command: `infer bdata linkedin jobs --location "United States" --company OpenAI --limit 50 --time-range "Past month"`,
			description: "What one company started hiring for recently",
		},
		{
			command: `infer bdata linkedin jobs --location Berlin --limit 20 --remote Remote --fields title`,
			description: "Remote roles, as a list of titles",
		},
	]),
);

const linkedinCmd = Command.make("linkedin").pipe(
	Command.withShortDescription(
		"Collect LinkedIn companies, people, posts and jobs.",
	),
	Command.withDescription(
		`LinkedIn data via Bright Data's Web Scraper API.

LinkedIn blocks ordinary fetching, so this is the only route to it here
— neither \`scrape\` nor a site: search reaches post text or job
listings.

\`company\` and \`profile\` collect records by URL; \`posts\` finds what
they publish; \`jobs\` searches postings.`,
	),
	Command.withSubcommands([
		linkedinCompanyCmd,
		linkedinProfileCmd,
		linkedinPostsCmd,
		linkedinJobsCmd,
	]),
);

// --- snapshots -------------------------------------------------------------

const SNAPSHOT_ID_NOTE =
	"The snapshot ID, as printed when a job was deferred or timed out.";

const snapshotListCmd = Command.make(
	"list",
	{
		dataset: Flag.String("dataset").pipe(
			Flag.withMetavar("name|id"),
			Flag.withDescription(
				`Required. Which dataset's jobs to list: a friendly name (${Object.keys(DATASETS).join(", ")}) or a raw gd_ id.`,
			),
		),
		status: Flag.Literals("status", SNAPSHOT_STATUSES).pipe(
			Flag.optional,
			Flag.withDescription("Only jobs in this state."),
		),
		limit: Flag.Int("limit").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription("How many to return. Defaults to the API's 1000."),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			const result = yield* bdata.snapshotList(resolveDataset(config.dataset), {
				status: Option.getOrUndefined(config.status),
				limit: Option.getOrUndefined(config.limit),
			});
			yield* Console.log(renderResult(result));
		}),
).pipe(
	Command.withShortDescription("List a dataset's jobs."),
	Command.withDescription(
		`List collection jobs for a dataset, newest first.

Each entry carries the snapshot id, when it was created, its status
(starting, running, ready or failed) and how many records it holds.

Listing costs nothing, so this is the cheap way to find a job that
outlived its poll, or to see how big a finished one is before
downloading it.`,
	),
	Command.withExamples([
		{
			command: "infer bdata snapshot list --dataset reddit --status ready",
			description: "Finished Reddit jobs",
		},
		{
			command: "infer bdata snapshot list --dataset x --status running",
			description: "What is still collecting, and billing",
		},
	]),
);

const snapshotStatusCmd = Command.make(
	"status",
	{
		id: Argument.String("snapshot-id").pipe(
			Argument.withDescription(SNAPSHOT_ID_NOTE),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* Console.log(renderResult(yield* bdata.snapshotStatus(config.id)));
		}),
).pipe(
	Command.withShortDescription("Check one job without downloading it."),
	Command.withDescription(
		`Report where a single collection job has got to.

Cheaper than downloading: use it to decide whether a job is worth
waiting for.`,
	),
);

const snapshotGetCmd = Command.make(
	"get",
	{
		id: Argument.String("snapshot-id").pipe(
			Argument.withDescription(SNAPSHOT_ID_NOTE),
		),
		fields: fieldsFlag,
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* emitRecords(yield* bdata.snapshotData(config.id), {
				compact: false,
				fields: config.fields,
			});
		}),
).pipe(
	Command.withShortDescription("Download a finished job's rows."),
	Command.withDescription(
		`Download the records of a completed collection job.

This is what rescues work that outlived its poll. Discovery commands
give up after ten minutes and print the snapshot ID; the job keeps
running on Bright Data's side, so collect it here once it is ready
rather than paying to run it again.

Downloading a job that is not \`ready\` returns its status instead of
rows.

Prints the rows as Bright Data stores them — the raw record, since a
snapshot does not say which command made it. --fields keeps only the
keys you name.`,
	),
	Command.withExamples([
		{
			command: "infer bdata snapshot get sd_msi2j99y2011k2jx5a | jq length",
			description: "Fetch a job that finished after its command gave up",
		},
	]),
);

const snapshotCancelCmd = Command.make(
	"cancel",
	{
		id: Argument.String("snapshot-id").pipe(
			Argument.withDescription(SNAPSHOT_ID_NOTE),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bdata = yield* Bdata;
			yield* Console.log(renderResult(yield* bdata.snapshotCancel(config.id)));
		}),
).pipe(
	Command.withShortDescription("Stop a running job."),
	Command.withDescription(
		`Cancel a collection job that is still running.

Every record a job collects is billed, so this is the brake for a
discovery run that is larger than intended. Records already collected
are still billed; cancelling stops it going further.`,
	),
);

const snapshotCmd = Command.make("snapshot").pipe(
	Command.withShortDescription("List, fetch and cancel collection jobs."),
	Command.withDescription(
		`Manage the jobs that discovery commands create.

Long jobs are queued to a snapshot and polled for up to ten minutes. A
job that outlives that is not lost — it keeps running on Bright Data's
side, and \`snapshot get\` collects it afterwards.

\`list\` finds jobs, \`status\` checks one, \`get\` downloads it, and
\`cancel\` stops one that is collecting more than you meant.`,
	),
	Command.withSubcommands([
		snapshotListCmd,
		snapshotStatusCmd,
		snapshotGetCmd,
		snapshotCancelCmd,
	]),
);

export const bdataCmd = Command.make("bdata").pipe(
	Command.withShortDescription("Scrape the web and query search engines."),
	Command.withDescription(
		`Web scraping, search engines and structured social data via Bright
Data.

\`scrape\` and \`search\` are the general-purpose pair; both accept several
targets at once and process them in parallel.

\`youtube\`, \`x\`, \`reddit\` and \`linkedin\` return structured records from
sites that mostly cannot be fetched directly. \`chatgpt\` asks an answer
engine and returns its citations. \`snapshot\` manages the jobs the
discovery commands create.`,
	),
	Command.withSubcommands([
		scrapeCmd,
		searchCmd,
		youtubeCmd,
		xCmd,
		redditCmd,
		linkedinCmd,
		chatgptCmd,
		snapshotCmd,
	]),
);
