/**
 * Bright Data — web scraping and search engine results.
 *
 * Wraps `@brightdata/sdk`. Option names and ranges mirror the SDK's own zod
 * schemas (`ScrapeOptionsSchema`, `SearchOptionsSchema`) so the CLI rejects
 * the same things the SDK would, but earlier and with a clearer message.
 */

import {
	Console,
	Context,
	Data,
	Effect,
	Layer,
	Option,
	Redacted,
	Schedule,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { MissingKeyError, Secrets } from "./secrets.ts";

/** Every unlocker and SERP call goes through this one endpoint. */
const REQUEST_URL = "https://api.brightdata.com/request";

/** Web Scraper API: dataset-backed collection and discovery. */
const DATASET_SCRAPE_URL = "https://api.brightdata.com/datasets/v3/scrape";
const DATASET_PROGRESS_URL = "https://api.brightdata.com/datasets/v3/progress";
const DATASET_SNAPSHOT_URL = "https://api.brightdata.com/datasets/v3/snapshot";
const DATASET_SNAPSHOTS_URL =
	"https://api.brightdata.com/datasets/v3/snapshots";

/** YouTube videos dataset — backs both collect-by-URL and discover-by-keyword. */
export const YOUTUBE_VIDEOS_DATASET = "gd_lk56epmy2i5g7lzu0k";

/** Zone names the Bright Data SDK creates and uses by default. */
export const DEFAULT_UNLOCKER_ZONE = "sdk_unlocker";
export const DEFAULT_SERP_ZONE = "sdk_serp";

export const SEARCH_ENGINES = ["google", "bing", "yandex"] as const;
export const FORMATS = ["raw", "json"] as const;
export const DATA_FORMATS = ["html", "markdown", "md", "screenshot"] as const;
export const METHODS = ["GET", "POST"] as const;

export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export class BdataError extends Data.TaggedError("BdataError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

/** Options shared by scrape and search, matching the SDK's base schema. */
export interface BaseOptions {
	readonly zone?: string;
	readonly country?: string;
	readonly method?: string;
	readonly format?: string;
	readonly dataFormat?: string;
	readonly concurrency?: number;
	readonly timeout?: number;
}

export interface SearchExtras {
	readonly language?: string;
	readonly numResults?: number;
	readonly start?: number;
}

export type ScrapeOptions = BaseOptions;
export type SearchOptions = BaseOptions & SearchExtras;

/**
 * Parses `--input` into an options object.
 *
 * Accepting a JSON blob alongside the flags keeps programmatic callers to one
 * payload, but it loses the flags' validation, so unknown keys are rejected
 * here rather than being silently dropped by the SDK's schema.
 */
export const parseInput = (
	raw: string,
	allowed: ReadonlyArray<string>,
):
	| { readonly options: Record<string, unknown> }
	| { readonly error: string } => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		return { error: `--input is not valid JSON: ${cause}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "--input must be a JSON object of options." };
	}
	const unknownKeys = Object.keys(parsed).filter(
		(key) => !allowed.includes(key),
	);
	if (unknownKeys.length > 0) {
		return {
			error: `--input has unknown option${unknownKeys.length > 1 ? "s" : ""}: ${unknownKeys.join(", ")}.\nAccepted: ${[...allowed].sort().join(", ")}`,
		};
	}
	return { options: parsed as Record<string, unknown> };
};

/** Explicit flags win over the same key in `--input`. */
export const mergeOptions = <A extends object>(
	fromInput: Record<string, unknown>,
	fromFlags: A,
): A => {
	const defined = Object.fromEntries(
		Object.entries(fromFlags).filter(([, value]) => value !== undefined),
	);
	return { ...fromInput, ...defined } as A;
};

/**
 * Renders a result for stdout.
 *
 * `--format raw`, the default, yields an HTML or markdown string that must be
 * printed as-is; `--format json` yields an object worth pretty-printing so it
 * can be piped into jq.
 */
export const renderResult = (result: unknown): string =>
	typeof result === "string" ? result : JSON.stringify(result, null, 2);

/**
 * Builds the search engine URL that Bright Data will fetch.
 *
 * Mirrors the SDK's own `buildSERPUrl`, including `brd_json=1` for Google,
 * which makes Bright Data return a parsed SERP object rather than raw HTML.
 */
export const buildSerpUrl = (
	engine: SearchEngine,
	query: string,
	options: SearchOptions,
): string => {
	const q = encodeURIComponent(query.trim());
	const num = options.numResults ?? 10;
	const lang = options.language ?? "en";

	switch (engine) {
		case "bing": {
			const base = `https://www.bing.com/search?q=${q}&count=${num}`;
			return options.country
				? `${base}&mkt=${lang}_${options.country.toUpperCase()}`
				: base;
		}
		case "yandex":
			return `https://yandex.com/search/?text=${q}&numdoc=${num}`;
		default: {
			let url = `https://www.google.com/search?q=${q}&brd_json=1`;
			if (options.start) url += `&start=${options.start}`;
			if (lang) url += `&hl=${lang}`;
			if (options.country) url += `&gl=${options.country}`;
			return url;
		}
	}
};

/**
 * The POST body for `/request`, matching the SDK's `getRequestBody`: undefined
 * keys are dropped, and `data_format` is sent only when it differs from the
 * default `html`.
 */
export const requestBody = (
	url: string,
	zone: string,
	options: BaseOptions,
	method: string,
): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		url,
		zone,
		method,
		format: options.format ?? "raw",
	};
	if (options.country) body.country = options.country;
	if (options.dataFormat && options.dataFormat !== "html") {
		// The SDK accepts md as an alias but the API expects markdown.
		body.data_format =
			options.dataFormat === "md" ? "markdown" : options.dataFormat;
	}
	return body;
};

/**
 * Parses a response body, keeping raw text as text.
 *
 * Dataset jobs that answer inline return **JSON Lines** when there is more
 * than one row — one object per line, which is not a JSON document. Left
 * alone it falls through to the raw-text branch and stdout stops being a
 * single JSON value, breaking the contract every command promises. Parsing it
 * into an array makes an inline answer indistinguishable from a snapshot
 * download, which already arrives as an array.
 */
export const parseBody = (text: string): unknown => {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return parseJsonLines(text) ?? text;
	}
};

/** An array when every non-empty line is its own JSON value, else null. */
export const parseJsonLines = (text: string): ReadonlyArray<unknown> | null => {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	if (lines.length < 2) return null;
	const rows: unknown[] = [];
	for (const line of lines) {
		try {
			rows.push(JSON.parse(line));
		} catch {
			return null;
		}
	}
	return rows;
};

export interface BdataShape {
	/** Scrape one or more URLs through the web unlocker. */
	readonly scrape: (
		urls: ReadonlyArray<string>,
		options: ScrapeOptions,
	) => Effect.Effect<unknown, BdataError>;
	/** Run one or more queries against a search engine. */
	readonly search: (
		engine: SearchEngine,
		queries: ReadonlyArray<string>,
		options: SearchOptions,
	) => Effect.Effect<unknown, BdataError>;
	/**
	 * Run a Web Scraper API dataset job, polling to completion when the API
	 * defers the work.
	 */
	readonly datasetScrape: (
		params: DatasetScrapeParams,
		input: ReadonlyArray<Record<string, unknown>>,
	) => Effect.Effect<unknown, BdataError>;
	/** List a dataset's jobs, newest first. */
	readonly snapshotList: (
		datasetId: string,
		options: SnapshotListOptions,
	) => Effect.Effect<unknown, BdataError>;
	/** Where one job has got to, without downloading it. */
	readonly snapshotStatus: (
		snapshotId: string,
	) => Effect.Effect<unknown, BdataError>;
	/** Download a finished job's rows. */
	readonly snapshotData: (
		snapshotId: string,
	) => Effect.Effect<unknown, BdataError>;
	/** Stop a running job, so it stops collecting billable records. */
	readonly snapshotCancel: (
		snapshotId: string,
	) => Effect.Effect<unknown, BdataError>;
}

export interface SnapshotListOptions {
	readonly status?: string;
	readonly limit?: number;
	readonly skip?: number;
}

/** Query string for `/datasets/v3/snapshots`. */
export const snapshotListQuery = (
	datasetId: string,
	options: SnapshotListOptions,
): string => {
	const query = new URLSearchParams({ dataset_id: datasetId });
	if (options.status) query.set("status", options.status);
	if (options.limit !== undefined) query.set("limit", String(options.limit));
	if (options.skip !== undefined) query.set("skip", String(options.skip));
	return query.toString();
};

/** The four states a job can be in. */
export const SNAPSHOT_STATUSES = [
	"starting",
	"running",
	"ready",
	"failed",
] as const;

export class Bdata extends Context.Service<Bdata, BdataShape>()("Bdata") {}

const make = (options: {
	readonly http: HttpClient.HttpClient;
	readonly credentials: Option.Option<string>;
}): BdataShape => {
	const { http, credentials } = options;

	const requireCredentials = Option.isSome(credentials)
		? Effect.succeed(credentials.value)
		: Effect.fail(
				new BdataError({
					reason: new MissingKeyError({ provider: "brightdata" }).message,
				}),
			);

	const call = (
		body: Record<string, unknown>,
	): Effect.Effect<unknown, BdataError> =>
		Effect.gen(function* () {
			const key = yield* requireCredentials;
			const response = yield* http
				.execute(
					HttpClientRequest.post(REQUEST_URL, {
						headers: {
							Authorization: `Bearer ${key}`,
							"Content-Type": "application/json",
						},
					}).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
				)
				.pipe(
					Effect.mapError(
						(cause) => new BdataError({ reason: `Request failed: ${cause}` }),
					),
				);

			const text = yield* response.text.pipe(
				Effect.mapError(
					(cause) =>
						new BdataError({ reason: `Could not read the response: ${cause}` }),
				),
			);

			if (response.status >= 400) {
				return yield* Effect.fail(
					new BdataError({
						reason: `Bright Data returned ${response.status}: ${text.slice(0, 500)}`,
					}),
				);
			}
			return parseBody(text);
		});

	const authorized = <A>(
		run: (key: string) => Effect.Effect<A, BdataError>,
	): Effect.Effect<A, BdataError> => Effect.flatMap(requireCredentials, run);

	const getJson = (url: string, key: string) =>
		Effect.gen(function* () {
			const response = yield* http
				.get(url, { headers: { Authorization: `Bearer ${key}` } })
				.pipe(
					Effect.mapError(
						(cause) => new BdataError({ reason: `Request failed: ${cause}` }),
					),
				);
			const text = yield* response.text.pipe(
				Effect.mapError(
					(cause) =>
						new BdataError({ reason: `Could not read the response: ${cause}` }),
				),
			);
			if (response.status >= 400) {
				return yield* Effect.fail(
					new BdataError({
						reason: `Bright Data returned ${response.status}: ${text.slice(0, 500)}`,
					}),
				);
			}
			return parseBody(text);
		});

	/**
	 * Waits for a deferred job, then downloads it.
	 *
	 * Discovery runs can take minutes, so this polls every 10 seconds for up to
	 * 10 minutes and reports progress on stderr to keep stdout pure JSON.
	 */
	const pollAndDownload = (snapshotId: string, key: string) =>
		Effect.gen(function* () {
			yield* Console.error(`Polling snapshot ${snapshotId}...`);

			const check = Effect.gen(function* () {
				const status = (yield* getJson(
					`${DATASET_PROGRESS_URL}/${snapshotId}`,
					key,
				)) as { status?: string };
				if (status.status === "ready" || status.status === "failed") {
					return status;
				}
				yield* Console.error(`  status: ${status.status ?? "unknown"}`);
				return yield* Effect.fail("pending" as const);
			});

			const final = yield* check.pipe(
				Effect.retry(
					Schedule.spaced("10 seconds").pipe(
						Schedule.upTo({ duration: "10 minutes" }),
					),
				),
				Effect.mapError(
					(cause): BdataError =>
						typeof cause === "string"
							? new BdataError({
									reason: `Snapshot ${snapshotId} was still running after 10 minutes.\nCheck it later with the snapshot ID above.`,
								})
							: cause,
				),
			);

			if (final.status === "failed") {
				return yield* Effect.fail(
					new BdataError({ reason: `Snapshot ${snapshotId} failed.` }),
				);
			}
			return yield* getJson(
				`${DATASET_SNAPSHOT_URL}/${snapshotId}?format=json`,
				key,
			);
		});

	/** One result for a single target, an array for several — like the SDK. */
	const runAll = (
		bodies: ReadonlyArray<Record<string, unknown>>,
		concurrency: number,
	): Effect.Effect<unknown, BdataError> =>
		bodies.length === 1 && bodies[0] !== undefined
			? call(bodies[0])
			: Effect.forEach(bodies, call, { concurrency });

	return {
		scrape: (urls, opts) =>
			runAll(
				urls.map((url) =>
					requestBody(
						url,
						opts.zone ?? DEFAULT_UNLOCKER_ZONE,
						opts,
						opts.method ?? "GET",
					),
				),
				opts.concurrency ?? 10,
			),

		search: (engine, queries, opts) =>
			runAll(
				queries.map((query) =>
					requestBody(
						buildSerpUrl(engine, query, opts),
						opts.zone ?? DEFAULT_SERP_ZONE,
						opts,
						"GET",
					),
				),
				opts.concurrency ?? 10,
			),

		datasetScrape: (params, input) =>
			authorized((key) =>
				Effect.gen(function* () {
					const url = `${DATASET_SCRAPE_URL}?${datasetScrapeQuery(params)}`;
					const response = yield* http
						.execute(
							HttpClientRequest.post(url, {
								headers: {
									Authorization: `Bearer ${key}`,
									"Content-Type": "application/json",
								},
							}).pipe(HttpClientRequest.bodyJsonUnsafe({ input })),
						)
						.pipe(
							Effect.mapError(
								(cause) =>
									new BdataError({ reason: `Request failed: ${cause}` }),
							),
						);

					const text = yield* response.text.pipe(
						Effect.mapError(
							(cause) =>
								new BdataError({
									reason: `Could not read the response: ${cause}`,
								}),
						),
					);

					// 202 means the work was deferred to a snapshot rather than run
					// inline, which is the normal path for discovery.
					if (response.status === 202) {
						const body = parseBody(text) as { snapshot_id?: string };
						if (!body.snapshot_id) {
							return yield* Effect.fail(
								new BdataError({
									reason: `Bright Data deferred the job but returned no snapshot id: ${text.slice(0, 300)}`,
								}),
							);
						}
						return yield* pollAndDownload(body.snapshot_id, key);
					}

					if (response.status >= 400) {
						return yield* Effect.fail(
							new BdataError({
								reason: `Bright Data returned ${response.status}: ${text.slice(0, 500)}`,
							}),
						);
					}
					return parseBody(text);
				}),
			),

		snapshotList: (datasetId, options) =>
			authorized((key) =>
				getJson(
					`${DATASET_SNAPSHOTS_URL}?${snapshotListQuery(datasetId, options)}`,
					key,
				),
			),

		snapshotStatus: (snapshotId) =>
			authorized((key) =>
				getJson(`${DATASET_PROGRESS_URL}/${snapshotId}`, key),
			),

		snapshotData: (snapshotId) =>
			authorized((key) =>
				getJson(`${DATASET_SNAPSHOT_URL}/${snapshotId}?format=json`, key),
			),

		snapshotCancel: (snapshotId) =>
			authorized((key) =>
				Effect.gen(function* () {
					const response = yield* http
						.execute(
							HttpClientRequest.post(
								`${DATASET_SNAPSHOT_URL}/${snapshotId}/cancel`,
								{ headers: { Authorization: `Bearer ${key}` } },
							),
						)
						.pipe(
							Effect.mapError(
								(cause) =>
									new BdataError({ reason: `Request failed: ${cause}` }),
							),
						);
					const text = yield* response.text.pipe(
						Effect.mapError(
							(cause) =>
								new BdataError({
									reason: `Could not read the response: ${cause}`,
								}),
						),
					);
					if (response.status >= 400) {
						return yield* Effect.fail(
							new BdataError({
								reason: `Bright Data returned ${response.status}: ${text.slice(0, 500)}`,
							}),
						);
					}
					// The endpoint answers with the bare word OK, which is not JSON.
					return {
						snapshot_id: snapshotId,
						cancelled: true,
						response: text.trim(),
					};
				}),
			),
	};
};

export const layer: Layer.Layer<Bdata, never, Secrets | HttpClient.HttpClient> =
	Layer.effect(Bdata)(
		Effect.gen(function* () {
			const secrets = yield* Secrets;
			const http = yield* HttpClient.HttpClient;
			const resolved = yield* secrets
				.get("brightdata")
				.pipe(Effect.orElseSucceed(Option.none));
			return make({
				http,
				credentials: Option.map(resolved, (r) => Redacted.value(r.key)),
			});
		}),
	);

// --- Web Scraper API (datasets) -------------------------------------------

export interface DatasetScrapeParams {
	readonly datasetId: string;
	/** `discover_new` turns a collect request into a discovery run. */
	readonly type?: string;
	/** What the input keys mean when discovering, e.g. `keyword`. */
	readonly discoverBy?: string;
	readonly limitPerInput?: number;
	readonly includeErrors?: boolean;
}

/** Query string for `/datasets/v3/scrape`. */
export const datasetScrapeQuery = (params: DatasetScrapeParams): string => {
	const query = new URLSearchParams({ dataset_id: params.datasetId });
	// Errors are included by default so a partly-failed batch still explains
	// itself instead of silently returning fewer rows.
	query.set("include_errors", String(params.includeErrors ?? true));
	if (params.type) query.set("type", params.type);
	if (params.discoverBy) query.set("discover_by", params.discoverBy);
	if (params.limitPerInput !== undefined) {
		query.set("limit_per_input", String(params.limitPerInput));
	}
	return query.toString();
};

export interface VideoInputOptions {
	readonly country?: string;
	readonly transcriptionLanguage?: string;
}

/** Input rows for collecting YouTube videos by URL. */
export const videoInput = (
	urls: ReadonlyArray<string>,
	options: VideoInputOptions,
): ReadonlyArray<Record<string, unknown>> =>
	urls.map((url) => {
		const row: Record<string, unknown> = { url };
		if (options.country) row.country = options.country;
		if (options.transcriptionLanguage) {
			row.transcription_language = options.transcriptionLanguage;
		}
		return row;
	});

export interface DiscoverInputOptions {
	/**
	 * Required, not optional.
	 *
	 * The API treats a missing `num_of_posts` as "no limit", and a keyword can
	 * match an unbounded number of videos — each one billed. Making this
	 * mandatory in the type means a caller cannot start a runaway job by
	 * forgetting a flag. See `docs/adrs/0011`.
	 */
	readonly numOfPosts: number;
	readonly startDate?: string;
	readonly endDate?: string;
	readonly country?: string;
}

// --- X (Twitter) and Reddit datasets ---------------------------------------

/** X posts — backs collect-by-URL and both discovery routes. */
export const X_POSTS_DATASET = "gd_lwxkxvnf1cynvib9co";
/** Reddit posts — backs collect-by-URL, keyword and subreddit discovery. */
export const REDDIT_POSTS_DATASET = "gd_lvz8ah06191smkebj4";
/** Reddit comments — a separate dataset from posts, with its own record shape. */
export const REDDIT_COMMENTS_DATASET = "gd_lvzdpsdlw09j6t702";
/** YouTube comments — separate from the videos dataset. */
export const YOUTUBE_COMMENTS_DATASET = "gd_lk9q0ew71spt1mxywf";
/** LinkedIn posts — one dataset, discovered by company URL or by profile URL. */
export const LINKEDIN_POSTS_DATASET = "gd_lyy3tktm25m4avu764";
export const LINKEDIN_COMPANIES_DATASET = "gd_l1vikfnt1wgvvqz95w";
export const LINKEDIN_PROFILES_DATASET = "gd_l1viktl72bvl7bjuj0";
export const LINKEDIN_JOBS_DATASET = "gd_lpfll7v5hcqtkxl6l";
/** ChatGPT answers with citations, billed per prompt rather than per token. */
export const CHATGPT_DATASET = "gd_m7aof0k82r803d5bjm";

/**
 * Friendly names for the datasets this CLI drives.
 *
 * `snapshot list` needs a dataset id, and nobody remembers `gd_lwxkxvnf1cynvib9co`.
 * A raw id is still accepted, so an id this map does not know still works.
 */
export const DATASETS: Readonly<Record<string, string>> = {
	x: X_POSTS_DATASET,
	reddit: REDDIT_POSTS_DATASET,
	"reddit-comments": REDDIT_COMMENTS_DATASET,
	youtube: YOUTUBE_VIDEOS_DATASET,
	"youtube-comments": YOUTUBE_COMMENTS_DATASET,
	linkedin: LINKEDIN_POSTS_DATASET,
	"linkedin-companies": LINKEDIN_COMPANIES_DATASET,
	"linkedin-profiles": LINKEDIN_PROFILES_DATASET,
	"linkedin-jobs": LINKEDIN_JOBS_DATASET,
	chatgpt: CHATGPT_DATASET,
};

/** Resolves a friendly dataset name, passing an unknown `gd_` id through. */
export const resolveDataset = (nameOrId: string): string =>
	DATASETS[nameOrId] ?? nameOrId;

/**
 * Capitalised, and `Rising` exists.
 *
 * The published docs say `new`, `top`, `hot`; the API rejects all three with
 * "This value is not allowed". These are the values it actually accepts.
 */
export const REDDIT_SORTS = ["Hot", "New", "Top", "Rising"] as const;

/** Date windows the keyword search accepts, exactly as spelled. */
export const REDDIT_DATES = [
	"Past hour",
	"Past day",
	"Past week",
	"Past month",
	"Past year",
	"All time",
] as const;

export interface DateWindow {
	readonly startDate?: string;
	readonly endDate?: string;
}

/** Input rows keyed only by URL — X posts, Reddit posts. */
export const urlInput = (
	urls: ReadonlyArray<string>,
): ReadonlyArray<Record<string, unknown>> => urls.map((url) => ({ url }));

/** Input rows for discovering X posts from one profile each. */
export const xProfileInput = (
	urls: ReadonlyArray<string>,
	window: DateWindow,
): ReadonlyArray<Record<string, unknown>> =>
	urls.map((url) => {
		const row: Record<string, unknown> = { url };
		if (window.startDate) row.start_date = window.startDate;
		if (window.endDate) row.end_date = window.endDate;
		return row;
	});

export interface RedditCommentsOptions {
	readonly daysBack?: number;
	readonly sortBy?: string;
}

/** Input rows for collecting the comments under a Reddit post. */
export const redditCommentsInput = (
	urls: ReadonlyArray<string>,
	options: RedditCommentsOptions,
): ReadonlyArray<Record<string, unknown>> =>
	urls.map((url) => {
		const row: Record<string, unknown> = { url };
		if (options.daysBack !== undefined) row.days_back = options.daysBack;
		if (options.sortBy) row.sort_by = options.sortBy;
		return row;
	});

export interface RedditKeywordOptions {
	/** Required for the same reason YouTube's is — see `docs/adrs/0011`. */
	readonly numOfPosts: number;
	readonly date?: string;
}

/** Input rows for discovering Reddit posts by keyword. */
export const redditKeywordInput = (
	keywords: ReadonlyArray<string>,
	options: RedditKeywordOptions,
): ReadonlyArray<Record<string, unknown>> =>
	keywords.map((keyword) => {
		const row: Record<string, unknown> = {
			keyword,
			num_of_posts: options.numOfPosts,
		};
		// The API rejects an empty string here, so the key is omitted entirely
		// rather than sent blank.
		if (options.date) row.date = options.date;
		return row;
	});

/** Input rows for discovering Reddit posts from a subreddit. */
export const redditSubredditInput = (
	urls: ReadonlyArray<string>,
	options: { readonly sortBy?: string },
): ReadonlyArray<Record<string, unknown>> =>
	urls.map((url) => {
		const row: Record<string, unknown> = { url };
		if (options.sortBy) row.sort_by = options.sortBy;
		return row;
	});

// --- LinkedIn --------------------------------------------------------------

/** Which discovery route a LinkedIn URL belongs to, or null if neither. */
export const linkedinUrlKind = (url: string): "company" | "profile" | null => {
	if (/linkedin\.com\/(company|school|showcase)\//i.test(url)) return "company";
	if (/linkedin\.com\/in\//i.test(url)) return "profile";
	return null;
};

export interface LinkedinPostsOptions extends DateWindow {
	/** Profile route only: drop reshares, keeping what the person wrote. */
	readonly authoredOnly?: boolean;
}

/** Input rows for discovering LinkedIn posts from a company or profile. */
export const linkedinPostsInput = (
	urls: ReadonlyArray<string>,
	options: LinkedinPostsOptions,
): ReadonlyArray<Record<string, unknown>> =>
	urls.map((url) => {
		const row: Record<string, unknown> = { url };
		if (options.startDate) row.start_date = options.startDate;
		if (options.endDate) row.end_date = options.endDate;
		if (options.authoredOnly) row.only_authored_posts = true;
		return row;
	});

export interface LinkedinJobsOptions {
	/** Required by the API even when a keyword is given. */
	readonly location: string;
	readonly keyword?: string;
	readonly country?: string;
	readonly timeRange?: string;
	readonly jobType?: string;
	readonly experienceLevel?: string;
	readonly remote?: string;
	readonly company?: string;
}

/**
 * Input rows for discovering LinkedIn jobs.
 *
 * `location` is the required field, not `keyword` — a keyword-less search of a
 * place is valid, a keyword without a place is not.
 */
export const linkedinJobsInput = (
	options: LinkedinJobsOptions,
): ReadonlyArray<Record<string, unknown>> => {
	const row: Record<string, unknown> = { location: options.location };
	if (options.keyword) row.keyword = options.keyword;
	if (options.country) row.country = options.country;
	if (options.timeRange) row.time_range = options.timeRange;
	if (options.jobType) row.job_type = options.jobType;
	if (options.experienceLevel) row.experience_level = options.experienceLevel;
	if (options.remote) row.remote = options.remote;
	if (options.company) row.company = options.company;
	return [row];
};

// --- ChatGPT ---------------------------------------------------------------

/** The dataset rejects any other value here, so it is never a caller's choice. */
const CHATGPT_URL = "https://chatgpt.com/";

export interface ChatgptOptions {
	readonly country?: string;
	readonly additionalPrompt?: string;
	/** Defaults to true API-side; sent only when explicitly turned off. */
	readonly webSearch?: boolean;
	readonly requireSources?: boolean;
}

/** Input rows for asking ChatGPT a question and getting its citations back. */
export const chatgptInput = (
	prompts: ReadonlyArray<string>,
	options: ChatgptOptions,
): ReadonlyArray<Record<string, unknown>> =>
	prompts.map((prompt) => {
		const row: Record<string, unknown> = { url: CHATGPT_URL, prompt };
		if (options.country) row.country = options.country;
		if (options.additionalPrompt)
			row.additional_prompt = options.additionalPrompt;
		if (options.webSearch === false) row.web_search = false;
		if (options.requireSources) row.require_sources = true;
		return row;
	});

/** Input rows for discovering YouTube videos by keyword. */
export const discoverInput = (
	keywords: ReadonlyArray<string>,
	options: DiscoverInputOptions,
): ReadonlyArray<Record<string, unknown>> =>
	keywords.map((keyword) => {
		// num_of_posts is always sent; omitting it would mean "no limit".
		const row: Record<string, unknown> = {
			keyword,
			num_of_posts: options.numOfPosts,
		};
		if (options.startDate) row.start_date = options.startDate;
		if (options.endDate) row.end_date = options.endDate;
		if (options.country) row.country = options.country;
		return row;
	});
