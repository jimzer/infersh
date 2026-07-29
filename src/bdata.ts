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

/** Parses a response body, keeping raw text as text. */
export const parseBody = (text: string): unknown => {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
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
}

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
