/**
 * Brightdata LinkedIn — 8 dataset actions via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, BdError, printResult, strip } from "./client.ts";

const PROFILES_ID = "gd_l1viktl72bvl7bjuj0";
const COMPANIES_ID = "gd_l1vikfnt1wgvvqz95w";
const JOBS_ID = "gd_lpfll7v5hcqtkxl6l";
const POSTS_ID = "gd_lyy3tktm25m4avu764";

// --- Schemas ---

const CollectProfilesInput = Schema.Struct({ url: Schema.String });
const DiscoverProfilesInput = Schema.Struct({
	first_name: Schema.String,
	last_name: Schema.String,
});
const CollectCompaniesInput = Schema.Struct({ url: Schema.String });
const CollectJobsInput = Schema.Struct({ url: Schema.String });
const DiscoverJobsInput = Schema.Struct({
	location: Schema.String,
	keyword: Schema.optionalKey(Schema.String),
	country: Schema.optionalKey(Schema.String),
	time_range: Schema.optionalKey(Schema.String),
	job_type: Schema.optionalKey(Schema.String),
	experience_level: Schema.optionalKey(Schema.String),
	remote: Schema.optionalKey(Schema.String),
	company: Schema.optionalKey(Schema.String),
});
const CollectPostsInput = Schema.Struct({ url: Schema.String });
const DiscoverUserPostsInput = Schema.Struct({ profile_url: Schema.String });
const DiscoverCompanyPostsInput = Schema.Struct({ company_url: Schema.String });

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
	"discover-profiles": {
		id: PROFILES_ID,
		mode: "trigger",
		schema: DiscoverProfilesInput,
	},
	"collect-companies": {
		id: COMPANIES_ID,
		mode: "collect",
		schema: CollectCompaniesInput,
	},
	"collect-jobs": { id: JOBS_ID, mode: "collect", schema: CollectJobsInput },
	"discover-jobs": {
		id: JOBS_ID,
		mode: "trigger",
		schema: DiscoverJobsInput,
	},
	"collect-posts": { id: POSTS_ID, mode: "collect", schema: CollectPostsInput },
	"discover-user-posts": {
		id: POSTS_ID,
		mode: "trigger",
		schema: DiscoverUserPostsInput,
	},
	"discover-company-posts": {
		id: POSTS_ID,
		mode: "trigger",
		schema: DiscoverCompanyPostsInput,
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
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) => ({ url: u }));
			const result = yield* bd.collect(PROFILES_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
		}),
);

const discoverProfilesCmd = Command.make(
	"discover-profiles",
	{
		firstName: Flag.string("first-name"),
		lastName: Flag.string("last-name"),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = [
				{
					first_name: config.firstName,
					last_name: config.lastName,
				},
			];
			const result = yield* bd.trigger(PROFILES_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
		}),
);

const collectCompaniesCmd = Command.make(
	"collect-companies",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) => ({ url: u }));
			const result = yield* bd.collect(COMPANIES_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
		}),
);

const collectJobsCmd = Command.make(
	"collect-jobs",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) => ({ url: u }));
			const result = yield* bd.collect(JOBS_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
		}),
);

const discoverJobsCmd = Command.make(
	"discover-jobs",
	{
		location: Flag.string("location"),
		keyword: Flag.string("keyword").pipe(Flag.optional),
		country: Flag.string("country").pipe(Flag.optional),
		timeRange: Flag.string("time-range").pipe(Flag.optional),
		jobType: Flag.string("job-type").pipe(Flag.optional),
		experienceLevel: Flag.string("experience-level").pipe(Flag.optional),
		remote: Flag.string("remote").pipe(Flag.optional),
		company: Flag.string("company").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = [
				strip({
					location: config.location,
					keyword: Option.getOrUndefined(config.keyword),
					country: Option.getOrUndefined(config.country),
					time_range: Option.getOrUndefined(config.timeRange),
					job_type: Option.getOrUndefined(config.jobType),
					experience_level: Option.getOrUndefined(config.experienceLevel),
					remote: Option.getOrUndefined(config.remote),
					company: Option.getOrUndefined(config.company),
				}),
			];
			const result = yield* bd.trigger(JOBS_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
		}),
);

const collectPostsCmd = Command.make(
	"collect-posts",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) => ({ url: u }));
			const result = yield* bd.collect(POSTS_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
		}),
);

const discoverUserPostsCmd = Command.make(
	"discover-user-posts",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) => ({ profile_url: u }));
			const result = yield* bd.trigger(POSTS_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
		}),
);

const discoverCompanyPostsCmd = Command.make(
	"discover-company-posts",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) => ({ company_url: u }));
			const result = yield* bd.trigger(POSTS_ID, input, {
				format: Option.getOrUndefined(config.format),
			});
			printResult(result);
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
					new BdError(`Unknown linkedin action: ${action}`),
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

export const linkedinCmd = Command.make("linkedin").pipe(
	Command.withSubcommands([
		collectProfilesCmd,
		discoverProfilesCmd,
		collectCompaniesCmd,
		collectJobsCmd,
		discoverJobsCmd,
		collectPostsCmd,
		discoverUserPostsCmd,
		discoverCompanyPostsCmd,
		jsonCmd,
	]),
);
