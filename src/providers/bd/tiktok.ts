/**
 * Brightdata TikTok — 3 APIs, 7 actions via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, BdError, printResult, strip } from "./client.ts";

const PROFILES_ID = "gd_l1villgoiiidt09ci";
const POSTS_ID = "gd_lu702nij2f790tmv9h";
const COMMENTS_ID = "gd_lkf2st302ap89utw5k";

const DATASET_IDS: Record<string, string> = {
	profiles: PROFILES_ID,
	posts: POSTS_ID,
	comments: COMMENTS_ID,
};

// --- Schemas ---

const CollectByUrlInput = Schema.Struct({ url: Schema.String });
const DiscoverBySearchInput = Schema.Struct({
	search_keyword: Schema.String,
});
const DiscoverByProfileInput = Schema.Struct({
	url: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
});
const DiscoverByKeywordInput = Schema.Struct({
	search_keyword: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
});

const API_SCHEMAS: Record<string, Record<string, Schema.Top>> = {
	profiles: {
		"collect-by-url": CollectByUrlInput,
		"discover-by-search": DiscoverBySearchInput,
	},
	posts: {
		"collect-by-url": CollectByUrlInput,
		"discover-by-profile": DiscoverByProfileInput,
		"discover-by-keyword": DiscoverByKeywordInput,
		"discover-by-url": CollectByUrlInput,
	},
	comments: {
		"collect-by-url": CollectByUrlInput,
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
	"discover-by-search",
	{ searchKeyword: Flag.string("search-keyword"), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					PROFILES_ID,
					[{ search_keyword: config.searchKeyword }],
					{ format: Option.getOrUndefined(config.format) },
				),
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

const postsDiscoverByProfileCmd = Command.make(
	"discover-by-profile",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		numOfPosts: Flag.integer("num-of-posts").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) =>
				strip({
					url: u,
					num_of_posts: Option.getOrUndefined(config.numOfPosts),
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
		searchKeyword: Flag.string("search-keyword"),
		numOfPosts: Flag.integer("num-of-posts").pipe(Flag.optional),
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
							search_keyword: config.searchKeyword,
							num_of_posts: Option.getOrUndefined(config.numOfPosts),
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

const postsDiscoverByUrlCmd = Command.make(
	"discover-by-url",
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

const postsCmd = Command.make("posts").pipe(
	Command.withSubcommands([
		postsCollectCmd,
		postsDiscoverByProfileCmd,
		postsDiscoverByKeywordCmd,
		postsDiscoverByUrlCmd,
	]),
);

// --- Comments commands ---

const commentsCollectCmd = Command.make(
	"collect-by-url",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					COMMENTS_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
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
				return yield* Effect.fail(new BdError(`Unknown tiktok api: ${api}`));
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

export const tiktokCmd = Command.make("tiktok").pipe(
	Command.withSubcommands([profilesCmd, postsCmd, commentsCmd, jsonCmd]),
);
