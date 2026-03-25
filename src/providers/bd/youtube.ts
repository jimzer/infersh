/**
 * Brightdata YouTube — 3 APIs, 8 actions via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, BdError, printResult, strip } from "./client.ts";

const PROFILES_ID = "gd_lk538t2k2p1k3oos71";
const POSTS_ID = "gd_lk56epmy2i5g7lzu0k";
const COMMENTS_ID = "gd_lk9q0ew71spt1mxywf";

const DATASET_IDS: Record<string, string> = {
	profiles: PROFILES_ID,
	posts: POSTS_ID,
	comments: COMMENTS_ID,
};

// --- Schemas ---

const CollectByUrlInput = Schema.Struct({ url: Schema.String });
const DiscoverByKeywordInput = Schema.Struct({ keyword: Schema.String });
const DiscoverByChannelInput = Schema.Struct({
	url: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
	start_date: Schema.optionalKey(Schema.String),
	end_date: Schema.optionalKey(Schema.String),
	order_by: Schema.optionalKey(Schema.String),
});
const DiscoverByKeywordPostsInput = Schema.Struct({
	keyword: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
	start_date: Schema.optionalKey(Schema.String),
	end_date: Schema.optionalKey(Schema.String),
});
const DiscoverBySearchFiltersInput = Schema.Struct({
	keyword_search: Schema.String,
	upload_date: Schema.optionalKey(Schema.String),
	type: Schema.optionalKey(Schema.String),
	duration: Schema.optionalKey(Schema.String),
	features: Schema.optionalKey(Schema.String),
});
const DiscoverByHashtagInput = Schema.Struct({
	hashtag: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
	start_date: Schema.optionalKey(Schema.String),
	end_date: Schema.optionalKey(Schema.String),
});
const CollectCommentsInput = Schema.Struct({
	url: Schema.String,
	load_replies: Schema.optionalKey(Schema.Number),
});

const API_SCHEMAS: Record<string, Record<string, Schema.Top>> = {
	profiles: {
		"collect-by-url": CollectByUrlInput,
		"discover-by-keyword": DiscoverByKeywordInput,
	},
	posts: {
		"collect-by-url": CollectByUrlInput,
		"discover-by-channel": DiscoverByChannelInput,
		"discover-by-keyword": DiscoverByKeywordPostsInput,
		"discover-by-search-filters": DiscoverBySearchFiltersInput,
		"discover-by-hashtag": DiscoverByHashtagInput,
	},
	comments: {
		"collect-by-url": CollectCommentsInput,
	},
};

// --- Shared flags ---

const formatFlag = Flag.choice("format", [
	"json",
	"ndjson",
	"jsonl",
	"csv",
] as const).pipe(Flag.optional);

// --- Profiles commands ---

const profilesCollectCmd = Command.make(
	"collect-by-url",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					PROFILES_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const profilesDiscoverCmd = Command.make(
	"discover-by-keyword",
	{ keyword: Flag.string("keyword"), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(PROFILES_ID, [{ keyword: config.keyword }], {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const profilesCmd = Command.make("profiles").pipe(
	Command.withSubcommands([profilesCollectCmd, profilesDiscoverCmd]),
);

// --- Posts commands ---

const postsCollectCmd = Command.make(
	"collect-by-url",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					POSTS_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const postsDiscoverByChannelCmd = Command.make(
	"discover-by-channel",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		numOfPosts: Flag.integer("num-of-posts").pipe(Flag.optional),
		startDate: Flag.string("start-date").pipe(Flag.optional),
		endDate: Flag.string("end-date").pipe(Flag.optional),
		orderBy: Flag.string("order-by").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) =>
				strip({
					url: u,
					num_of_posts: Option.getOrUndefined(config.numOfPosts),
					start_date: Option.getOrUndefined(config.startDate),
					end_date: Option.getOrUndefined(config.endDate),
					order_by: Option.getOrUndefined(config.orderBy),
				}),
			);
			printResult(
				yield* bd.trigger(POSTS_ID, input, {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const postsDiscoverByKeywordCmd = Command.make(
	"discover-by-keyword",
	{
		keyword: Flag.string("keyword"),
		numOfPosts: Flag.integer("num-of-posts").pipe(Flag.optional),
		startDate: Flag.string("start-date").pipe(Flag.optional),
		endDate: Flag.string("end-date").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					POSTS_ID,
					[
						strip({
							keyword: config.keyword,
							num_of_posts: Option.getOrUndefined(config.numOfPosts),
							start_date: Option.getOrUndefined(config.startDate),
							end_date: Option.getOrUndefined(config.endDate),
						}),
					],
					{
						format: Option.getOrUndefined(config.format),
						type: "discover_new",
						discover_by: "keyword",
					},
				),
			);
		}),
);

const postsDiscoverBySearchFiltersCmd = Command.make(
	"discover-by-search-filters",
	{
		keywordSearch: Flag.string("keyword-search"),
		uploadDate: Flag.string("upload-date").pipe(Flag.optional),
		type: Flag.string("type").pipe(Flag.optional),
		duration: Flag.string("duration").pipe(Flag.optional),
		features: Flag.string("features").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					POSTS_ID,
					[
						strip({
							keyword_search: config.keywordSearch,
							upload_date: Option.getOrUndefined(config.uploadDate),
							type: Option.getOrUndefined(config.type),
							duration: Option.getOrUndefined(config.duration),
							features: Option.getOrUndefined(config.features),
						}),
					],
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const postsDiscoverByHashtagCmd = Command.make(
	"discover-by-hashtag",
	{
		hashtag: Flag.string("hashtag"),
		numOfPosts: Flag.integer("num-of-posts").pipe(Flag.optional),
		startDate: Flag.string("start-date").pipe(Flag.optional),
		endDate: Flag.string("end-date").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					POSTS_ID,
					[
						strip({
							hashtag: config.hashtag,
							num_of_posts: Option.getOrUndefined(config.numOfPosts),
							start_date: Option.getOrUndefined(config.startDate),
							end_date: Option.getOrUndefined(config.endDate),
						}),
					],
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const postsCmd = Command.make("posts").pipe(
	Command.withSubcommands([
		postsCollectCmd,
		postsDiscoverByChannelCmd,
		postsDiscoverByKeywordCmd,
		postsDiscoverBySearchFiltersCmd,
		postsDiscoverByHashtagCmd,
	]),
);

// --- Comments commands ---

const commentsCollectCmd = Command.make(
	"collect-by-url",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		loadReplies: Flag.integer("load-replies").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) =>
				strip({
					url: u,
					load_replies: Option.getOrUndefined(config.loadReplies),
				}),
			);
			printResult(
				yield* bd.trigger(COMMENTS_ID, input, {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const commentsCmd = Command.make("comments").pipe(
	Command.withSubcommands([commentsCollectCmd]),
);

// --- JSON subcommand ---

const jsonCmd = Command.make(
	"json",
	{ payload: Argument.string("payload").pipe(Argument.optional) },
	(config) =>
		Effect.gen(function* () {
			if (Option.isNone(config.payload)) {
				const doc: Record<string, unknown> = {};
				for (const [api, actions] of Object.entries(API_SCHEMAS)) {
					const apiDoc: Record<string, unknown> = {};
					for (const [action, schema] of Object.entries(actions)) {
						apiDoc[action] = {
							input: Schema.toJsonSchemaDocument(schema).schema,
						};
					}
					doc[api] = apiDoc;
				}
				yield* Console.log(JSON.stringify(doc, null, 2));
				return;
			}
			const raw = JSON.parse(config.payload.value);
			const { api, input, format, discover_by } = raw;
			const id = DATASET_IDS[api];
			if (!id) {
				return yield* Effect.fail(new BdError(`Unknown youtube api: ${api}`));
			}
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(id, input, {
					...(format ? { format } : {}),
					...(discover_by ? { type: "discover_new", discover_by } : {}),
				}),
			);
		}),
);

// --- Composed command ---

export const youtubeCmd = Command.make("youtube").pipe(
	Command.withSubcommands([profilesCmd, postsCmd, commentsCmd, jsonCmd]),
);
