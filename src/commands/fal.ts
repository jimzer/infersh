/**
 * `infer fal` — search, inspect and run fal.ai models.
 */

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
	configureClient,
	extractInputSchema,
	FalError,
	fetchSpec,
	resolveAssets,
	runModel,
	searchModels,
	uploadFile,
} from "../fal.ts";

const ASSET_NOTE =
	"Any value that is a path to an existing local file is uploaded to the fal CDN and replaced by its URL; the mapping is printed to stderr so stdout stays clean JSON.";

// --- models ---------------------------------------------------------------

const modelsCmd = Command.make(
	"models",
	{
		query: Flag.string("q").pipe(
			Flag.optional,
			Flag.withDescription(
				"Free-text search over name, description and category",
			),
		),
		category: Flag.string("category").pipe(
			Flag.optional,
			Flag.withDescription("Filter by category, e.g. text-to-image"),
		),
		status: Flag.choice("status", ["active", "deprecated"]).pipe(
			Flag.optional,
			Flag.withDescription("Filter by status; omit for all"),
		),
		endpointId: Flag.string("endpoint-id").pipe(
			Flag.atLeast(0),
			Flag.withDescription("Look up specific endpoint IDs; repeatable"),
		),
		limit: Flag.integer("limit").pipe(
			Flag.optional,
			Flag.withDescription("Maximum number of models to return"),
		),
		cursor: Flag.string("cursor").pipe(
			Flag.optional,
			Flag.withDescription("Pagination cursor from a previous response"),
		),
		json: Flag.boolean("json").pipe(
			Flag.withDescription("Print the raw API response"),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const result = yield* searchModels({
				q: Option.getOrUndefined(config.query),
				category: Option.getOrUndefined(config.category),
				status: Option.getOrUndefined(config.status),
				limit: Option.getOrUndefined(config.limit),
				cursor: Option.getOrUndefined(config.cursor),
				endpointIds: config.endpointId,
				expand: [],
			});

			if (config.json) {
				yield* Console.log(JSON.stringify(result, null, 2));
				return;
			}

			if (result.models.length === 0) {
				yield* Console.error("No models matched.");
				return;
			}

			for (const model of result.models) {
				const category = model.metadata?.category;
				yield* Console.log(
					category ? `${model.endpoint_id}  [${category}]` : model.endpoint_id,
				);
			}

			if (result.has_more && result.next_cursor) {
				yield* Console.error(`\nMore results: --cursor ${result.next_cursor}`);
			}
		}),
).pipe(
	Command.withDescription(
		"Search fal.ai models. With no filters, lists what is available.",
	),
);

// --- schema ---------------------------------------------------------------

const schemaCmd = Command.make(
	"schema",
	{
		endpointId: Argument.string("endpoint-id"),
		full: Flag.boolean("full").pipe(
			Flag.withDescription(
				"Print the whole OpenAPI document, not just the input",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const spec = yield* fetchSpec(config.endpointId);
			if (config.full) {
				yield* Console.log(JSON.stringify(spec, null, 2));
				return;
			}
			const schema = extractInputSchema(spec);
			if (schema === null) {
				return yield* Effect.fail(
					new FalError({
						reason: `No input schema found for ${config.endpointId}.`,
					}),
				);
			}
			yield* Console.log(JSON.stringify(schema, null, 2));
		}),
).pipe(
	Command.withDescription(
		"Print a model's input schema, with every $ref resolved inline.",
	),
);

// --- run ------------------------------------------------------------------

// Effect CLI reuses the full description in the parent's subcommand listing,
// so this stays one line and the detail lives on the flag it belongs to.
const RUN_DESCRIPTION =
	"Run a fal.ai model and print its output as JSON. Local file paths in --input are uploaded to the fal CDN first.";

const runCmd = Command.make(
	"run",
	{
		endpointId: Argument.string("endpoint-id"),
		input: Flag.string("input").pipe(
			Flag.withDescription(
				`Model input as a JSON object, e.g. '{"prompt":"a cat"}'. ${ASSET_NOTE}`,
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			yield* configureClient;

			const parsed = yield* Effect.try({
				try: () => JSON.parse(config.input) as unknown,
				catch: (cause) =>
					new FalError({ reason: `--input is not valid JSON: ${cause}` }),
			});

			const input = yield* resolveAssets(parsed);
			const output = yield* runModel(config.endpointId, input);
			yield* Console.log(JSON.stringify(output, null, 2));
		}),
).pipe(Command.withDescription(RUN_DESCRIPTION));

// --- cdn ------------------------------------------------------------------

const cdnCmd = Command.make(
	"cdn",
	{ files: Argument.string("file").pipe(Argument.atLeast(1)) },
	(config) =>
		Effect.gen(function* () {
			yield* configureClient;
			for (const file of config.files) {
				const url = yield* uploadFile(file);
				yield* Console.log(url);
			}
		}),
).pipe(
	Command.withDescription(
		"Upload files to the fal CDN and print their URLs, one per line.",
	),
);

export const falCmd = Command.make("fal").pipe(
	Command.withDescription("Search and run fal.ai models."),
	Command.withSubcommands([modelsCmd, schemaCmd, runCmd, cdnCmd]),
);
