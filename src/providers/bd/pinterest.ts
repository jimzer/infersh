/**
 * Brightdata Pinterest — 2 APIs, 5 actions via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, BdError, printResult, strip } from "./client.ts";

const PROFILES_ID = "gd_lk0zv93c2m9qdph46z";
const POSTS_ID = "gd_lk0sjs4d21kdr7cnlv";

const DATASET_IDS: Record<string, string> = {
	profiles: PROFILES_ID,
	posts: POSTS_ID,
};

// --- Schemas ---

const CollectByUrlInput = Schema.Struct({ url: Schema.String });
const DiscoverByKeywordInput = Schema.Struct({ keyword: Schema.String });
const DiscoverByProfileInput = Schema.Struct({
	url: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
	start_date: Schema.optionalKey(Schema.String),
	end_date: Schema.optionalKey(Schema.String),
});

const API_SCHEMAS: Record<string, Record<string, Schema.Top>> = {
	profiles: {
		"collect-by-url": CollectByUrlInput,
		"discover-by-keyword": DiscoverByKeywordInput,
	},
	posts: {
		"collect-by-url": CollectByUrlInput,
		"discover-by-profile": DiscoverByProfileInput,
		"discover-by-keyword": DiscoverByKeywordInput,
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

const postsDiscoverByProfileCmd = Command.make(
	"discover-by-profile",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		numOfPosts: Flag.integer("num-of-posts").pipe(Flag.optional),
		startDate: Flag.string("start-date").pipe(Flag.optional),
		endDate: Flag.string("end-date").pipe(Flag.optional),
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
	{ keyword: Flag.string("keyword"), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(POSTS_ID, [{ keyword: config.keyword }], {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const postsCmd = Command.make("posts").pipe(
	Command.withSubcommands([
		postsCollectCmd,
		postsDiscoverByProfileCmd,
		postsDiscoverByKeywordCmd,
	]),
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
				return yield* Effect.fail(new BdError(`Unknown pinterest api: ${api}`));
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

export const pinterestCmd = Command.make("pinterest").pipe(
	Command.withSubcommands([profilesCmd, postsCmd, jsonCmd]),
);
