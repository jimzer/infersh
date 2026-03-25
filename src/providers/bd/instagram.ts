/**
 * Brightdata Instagram — 7 dataset actions via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, BdError, printResult, strip } from "./client.ts";

const PROFILES_ID = "gd_l1vikfch901nx3by4";
const POSTS_ID = "gd_lk5ns7kz21pck8jpis";
const REELS_ID = "gd_lyclm20il4r5helnj";
const COMMENTS_ID = "gd_ltppn085pokosxh13";

// --- Schemas ---

const CollectProfilesInput = Schema.Struct({ url: Schema.String });
const CollectPostsInput = Schema.Struct({ url: Schema.String });
const DiscoverPostsByProfileInput = Schema.Struct({
	url: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
	start_date: Schema.optionalKey(Schema.String),
	end_date: Schema.optionalKey(Schema.String),
	post_type: Schema.optionalKey(Schema.String),
});
const CollectReelsInput = Schema.Struct({ url: Schema.String });
const DiscoverReelsByProfileInput = Schema.Struct({
	url: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
	start_date: Schema.optionalKey(Schema.String),
	end_date: Schema.optionalKey(Schema.String),
});
const DiscoverAllReelsByProfileInput = Schema.Struct({
	url_all_reels: Schema.String,
	num_of_posts: Schema.optionalKey(Schema.Number),
	start_date: Schema.optionalKey(Schema.String),
	end_date: Schema.optionalKey(Schema.String),
});
const CollectCommentsInput = Schema.Struct({ url: Schema.String });

// --- Actions table ---

const ACTIONS: Record<
	string,
	{
		id: string;
		mode: "collect" | "trigger";
		schema: Schema.Top & { readonly DecodingServices: never };
	}
> = {
	"collect-profiles": {
		id: PROFILES_ID,
		mode: "collect",
		schema: CollectProfilesInput,
	},
	"collect-posts": { id: POSTS_ID, mode: "collect", schema: CollectPostsInput },
	"discover-posts-by-profile": {
		id: POSTS_ID,
		mode: "trigger",
		schema: DiscoverPostsByProfileInput,
	},
	"collect-reels": {
		id: REELS_ID,
		mode: "collect",
		schema: CollectReelsInput,
	},
	"discover-reels-by-profile": {
		id: REELS_ID,
		mode: "trigger",
		schema: DiscoverReelsByProfileInput,
	},
	"discover-all-reels-by-profile": {
		id: REELS_ID,
		mode: "trigger",
		schema: DiscoverAllReelsByProfileInput,
	},
	"collect-comments": {
		id: COMMENTS_ID,
		mode: "collect",
		schema: CollectCommentsInput,
	},
};

// --- Shared flags ---

const formatFlag = Flag.choice("format", [
	"json",
	"ndjson",
	"jsonl",
	"csv",
] as const).pipe(Flag.optional);

// --- Commands ---

const collectProfilesCmd = Command.make(
	"collect-profiles",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.collect(
					PROFILES_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const collectPostsCmd = Command.make(
	"collect-posts",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.collect(
					POSTS_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const discoverPostsByProfileCmd = Command.make(
	"discover-posts-by-profile",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		numOfPosts: Flag.integer("num-of-posts").pipe(Flag.optional),
		startDate: Flag.string("start-date").pipe(Flag.optional),
		endDate: Flag.string("end-date").pipe(Flag.optional),
		postType: Flag.string("post-type").pipe(Flag.optional),
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
					post_type: Option.getOrUndefined(config.postType),
				}),
			);
			printResult(
				yield* bd.trigger(POSTS_ID, input, {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const collectReelsCmd = Command.make(
	"collect-reels",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.collect(
					REELS_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const discoverReelsByProfileCmd = Command.make(
	"discover-reels-by-profile",
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
				yield* bd.trigger(REELS_ID, input, {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const discoverAllReelsByProfileCmd = Command.make(
	"discover-all-reels-by-profile",
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
					url_all_reels: u,
					num_of_posts: Option.getOrUndefined(config.numOfPosts),
					start_date: Option.getOrUndefined(config.startDate),
					end_date: Option.getOrUndefined(config.endDate),
				}),
			);
			printResult(
				yield* bd.trigger(REELS_ID, input, {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const collectCommentsCmd = Command.make(
	"collect-comments",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.collect(
					COMMENTS_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

// --- JSON subcommand ---

const jsonCmd = Command.make(
	"json",
	{ payload: Argument.string("payload").pipe(Argument.optional) },
	(config) =>
		Effect.gen(function* () {
			if (Option.isNone(config.payload)) {
				const doc: Record<string, unknown> = {};
				for (const [name, def] of Object.entries(ACTIONS)) {
					doc[name] = {
						input: Schema.toJsonSchemaDocument(def.schema).schema,
					};
				}
				yield* Console.log(JSON.stringify(doc, null, 2));
				return;
			}
			const raw = JSON.parse(config.payload.value);
			const { action, input, format } = raw;
			const def = ACTIONS[action];
			if (!def) {
				return yield* Effect.fail(
					new BdError(`Unknown instagram action: ${action}`),
				);
			}
			const validated = (Array.isArray(input) ? input : [input]).map(
				(item: unknown) => Schema.decodeUnknownSync(def.schema)(item),
			);
			const bd = yield* Bd;
			const opts = format ? { format } : undefined;
			const result =
				def.mode === "collect"
					? yield* bd.collect(def.id, validated, opts)
					: yield* bd.trigger(def.id, validated, opts);
			printResult(result);
		}),
);

// --- Composed command ---

export const instagramCmd = Command.make("instagram").pipe(
	Command.withSubcommands([
		collectProfilesCmd,
		collectPostsCmd,
		discoverPostsByProfileCmd,
		collectReelsCmd,
		discoverReelsByProfileCmd,
		discoverAllReelsByProfileCmd,
		collectCommentsCmd,
		jsonCmd,
	]),
);
