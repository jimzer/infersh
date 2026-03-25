/**
 * Brightdata Google — Maps APIs (full info + reviews), 5 actions via REST.
 */

import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Bd, BdError, printResult, strip } from "./client.ts";

const MAPS_FULL_INFO_ID = "gd_m8ebnr0q2qlklc02fz";
const MAPS_REVIEWS_ID = "gd_luzfs1dn2oa0teb81";

const DATASET_IDS: Record<string, string> = {
	"maps-full-info": MAPS_FULL_INFO_ID,
	"maps-reviews": MAPS_REVIEWS_ID,
};

// --- Schemas ---

const MapsCollectByUrlInput = Schema.Struct({ url: Schema.String });
const MapsDiscoverByCidInput = Schema.Struct({ CID: Schema.String });
const MapsDiscoverByPlaceIdInput = Schema.Struct({ place_id: Schema.String });
const MapsDiscoverByLocationInput = Schema.Struct({
	country: Schema.String,
	keyword: Schema.String,
	lat: Schema.optionalKey(Schema.Number),
	long: Schema.optionalKey(Schema.Number),
	zoom_level: Schema.optionalKey(Schema.Number),
});
const MapsReviewsCollectByUrlInput = Schema.Struct({
	url: Schema.String,
	days_limit: Schema.optionalKey(Schema.Number),
});

const API_SCHEMAS: Record<string, Record<string, Schema.Top>> = {
	"maps-full-info": {
		"collect-by-url": MapsCollectByUrlInput,
		"discover-by-cid": MapsDiscoverByCidInput,
		"discover-by-location": MapsDiscoverByLocationInput,
		"discover-by-place-id": MapsDiscoverByPlaceIdInput,
	},
	"maps-reviews": {
		"collect-by-url": MapsReviewsCollectByUrlInput,
	},
};

// --- Shared flags ---

const formatFlag = Flag.choice("format", [
	"json",
	"ndjson",
	"jsonl",
	"csv",
] as const).pipe(Flag.optional);

// --- Maps Full Info commands ---

const mapsFullInfoCollectCmd = Command.make(
	"collect-by-url",
	{ url: Flag.string("url").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					MAPS_FULL_INFO_ID,
					config.url.map((u) => ({ url: u })),
					{ format: Option.getOrUndefined(config.format) },
				),
			);
		}),
);

const mapsFullInfoDiscoverByCidCmd = Command.make(
	"discover-by-cid",
	{ cid: Flag.string("cid").pipe(Flag.atLeast(1)), format: formatFlag },
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					MAPS_FULL_INFO_ID,
					config.cid.map((c) => ({ CID: c })),
					{
						format: Option.getOrUndefined(config.format),
						type: "discover_new",
						discover_by: "cid",
					},
				),
			);
		}),
);

const mapsFullInfoDiscoverByLocationCmd = Command.make(
	"discover-by-location",
	{
		country: Flag.string("country"),
		keyword: Flag.string("keyword"),
		lat: Flag.float("lat").pipe(Flag.optional),
		long: Flag.float("long").pipe(Flag.optional),
		zoomLevel: Flag.integer("zoom-level").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					MAPS_FULL_INFO_ID,
					[
						strip({
							country: config.country,
							keyword: config.keyword,
							lat: Option.getOrUndefined(config.lat),
							long: Option.getOrUndefined(config.long),
							zoom_level: Option.getOrUndefined(config.zoomLevel),
						}),
					],
					{
						format: Option.getOrUndefined(config.format),
						type: "discover_new",
						discover_by: "location",
					},
				),
			);
		}),
);

const mapsFullInfoDiscoverByPlaceIdCmd = Command.make(
	"discover-by-place-id",
	{
		placeId: Flag.string("place-id").pipe(Flag.atLeast(1)),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			printResult(
				yield* bd.trigger(
					MAPS_FULL_INFO_ID,
					config.placeId.map((p) => ({ place_id: p })),
					{
						format: Option.getOrUndefined(config.format),
						type: "discover_new",
						discover_by: "place_id",
					},
				),
			);
		}),
);

const mapsFullInfoCmd = Command.make("maps-full-info").pipe(
	Command.withSubcommands([
		mapsFullInfoCollectCmd,
		mapsFullInfoDiscoverByCidCmd,
		mapsFullInfoDiscoverByLocationCmd,
		mapsFullInfoDiscoverByPlaceIdCmd,
	]),
);

// --- Maps Reviews commands ---

const mapsReviewsCollectCmd = Command.make(
	"collect-by-url",
	{
		url: Flag.string("url").pipe(Flag.atLeast(1)),
		daysLimit: Flag.integer("days-limit").pipe(Flag.optional),
		format: formatFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const bd = yield* Bd;
			const input = config.url.map((u) =>
				strip({
					url: u,
					days_limit: Option.getOrUndefined(config.daysLimit),
				}),
			);
			printResult(
				yield* bd.trigger(MAPS_REVIEWS_ID, input, {
					format: Option.getOrUndefined(config.format),
				}),
			);
		}),
);

const mapsReviewsCmd = Command.make("maps-reviews").pipe(
	Command.withSubcommands([mapsReviewsCollectCmd]),
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
				return yield* Effect.fail(new BdError(`Unknown google api: ${api}`));
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

export const googleCmd = Command.make("google").pipe(
	Command.withSubcommands([mapsFullInfoCmd, mapsReviewsCmd, jsonCmd]),
);
