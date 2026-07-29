/**
 * `infer fal` — search, inspect and run fal.ai models.
 */

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { extractInputSchema, Fal, FalError } from "../fal.ts";

// --- models ---------------------------------------------------------------

const modelsCmd = Command.make(
	"models",
	{
		query: Flag.string("q").pipe(
			Flag.withMetavar("text"),
			Flag.optional,
			Flag.withDescription(
				"Free-text search across model names, descriptions and categories.",
			),
		),
		category: Flag.string("category").pipe(
			Flag.withMetavar("name"),
			Flag.optional,
			Flag.withDescription(
				"Restrict to one category, e.g. text-to-image, image-to-video, training.",
			),
		),
		status: Flag.choice("status", ["active", "deprecated"]).pipe(
			Flag.optional,
			Flag.withDescription(
				"Restrict to active or deprecated models. Omit to include both.",
			),
		),
		endpointId: Flag.string("endpoint-id").pipe(
			Flag.withMetavar("id"),
			Flag.atLeast(0),
			Flag.withDescription(
				"Look up specific endpoints by exact ID instead of searching. Repeat the flag for up to 50 models.",
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withMetavar("n"),
			Flag.optional,
			Flag.withDescription(
				"Maximum number of models to return in one page. Defaults to the API's own page size.",
			),
		),
		cursor: Flag.string("cursor").pipe(
			Flag.withMetavar("token"),
			Flag.optional,
			Flag.withDescription(
				"Fetch the next page, using the cursor printed at the end of the previous run.",
			),
		),
		json: Flag.boolean("json").pipe(
			Flag.withDescription(
				"Print the raw API response instead of one endpoint ID per line.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const fal = yield* Fal;
			const result = yield* fal.searchModels({
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
	Command.withShortDescription("Search or list fal.ai model endpoints."),
	Command.withDescription(
		`Discover fal.ai model endpoints.

With no flags, lists what is available. Filters narrow the list, and
--endpoint-id looks up exact IDs instead of searching.

Prints one endpoint ID per line with its category, so results pipe
straight into other commands. Use --json for the full metadata.

An API key is optional here; providing one only raises the rate limit.`,
	),
	Command.withExamples([
		{ command: "infer fal models", description: "List available models" },
		{
			command: 'infer fal models --q "text to image" --limit 10',
			description: "Search by free text",
		},
		{
			command: "infer fal models --category image-to-video --status active",
			description: "Filter by category and status",
		},
		{
			command: "infer fal models --endpoint-id fal-ai/flux/dev --json",
			description: "Fetch full metadata for one endpoint",
		},
	]),
);

// --- schema ---------------------------------------------------------------

const schemaCmd = Command.make(
	"schema",
	{
		endpointId: Argument.string("endpoint-id").pipe(
			Argument.withDescription(
				"The model to inspect, e.g. fal-ai/flux/dev. Find one with `infer fal models`.",
			),
		),
		full: Flag.boolean("full").pipe(
			Flag.withDescription(
				"Print the entire OpenAPI document rather than only the input schema.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const fal = yield* Fal;
			const spec = yield* fal.fetchSpec(config.endpointId);
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
	Command.withShortDescription("Show a model's accepted input fields."),
	Command.withDescription(
		`Print the input schema a model accepts, as JSON.

Every $ref is resolved inline, so the output is a self-contained
description of the fields, their types, defaults and which are
required — exactly what --input on \`infer fal run\` expects.`,
	),
	Command.withExamples([
		{
			command: "infer fal schema fal-ai/flux/dev",
			description: "Show the accepted input fields",
		},
		{
			command: "infer fal schema fal-ai/flux/dev | jq '.required'",
			description: "List only the required fields",
		},
		{
			command: "infer fal schema fal-ai/flux/dev --full",
			description: "Show the whole OpenAPI document",
		},
	]),
);

// --- run ------------------------------------------------------------------

const runCmd = Command.make(
	"run",
	{
		endpointId: Argument.string("endpoint-id").pipe(
			Argument.withDescription(
				"The model to run, e.g. fal-ai/flux/schnell. Find one with `infer fal models`.",
			),
		),
		input: Flag.string("input").pipe(
			Flag.withMetavar("json"),
			Flag.withDescription(
				`The model's input as a JSON object, e.g. '{"prompt":"a cat"}'. Run \`infer fal schema <endpoint-id>\` to see the accepted fields. Any value that is a path to an existing local file is uploaded to the fal CDN and replaced by its URL, at any depth and whatever the field is called; each upload is reported on stderr.`,
			),
		),
		output: Flag.string("output").pipe(
			Flag.withMetavar("path"),
			Flag.optional,
			Flag.withDescription(
				"Download the produced assets to this path and print what was written, instead of printing the result JSON. A directory (or a path ending in /) keeps the model's own filenames; otherwise the first asset takes the path exactly and any others are numbered out.png, out-2.png. The raw result is still written to stderr.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const fal = yield* Fal;

			const parsed = yield* Effect.try({
				try: () => JSON.parse(config.input) as unknown,
				catch: (cause) =>
					new FalError({ reason: `--input is not valid JSON: ${cause}` }),
			});

			const input = yield* fal.resolveAssets(parsed);
			const output = yield* fal.run(config.endpointId, input);

			if (Option.isNone(config.output)) {
				yield* Console.log(JSON.stringify(output, null, 2));
				return;
			}

			// Keep the result reachable on stderr: it carries the seed and timings,
			// which are gone for good once the run is billed.
			yield* Console.error(JSON.stringify(output, null, 2));
			const written = yield* fal.saveOutputs(output, config.output.value);
			for (const path of written) {
				yield* Console.log(path);
			}
		}),
).pipe(
	Command.withShortDescription("Run a model and print or save its output."),
	Command.withDescription(
		`Run a fal.ai model and wait for the result.

Prints the raw JSON output on stdout. With --output, downloads the
produced assets instead and prints the paths written, so stdout is
always safe to pipe.

Local files referenced in --input are uploaded automatically, so a
path can be passed anywhere a model expects an asset URL.

Requires a fal.ai API key: run \`infer keys set\` or set FAL_KEY.`,
	),
	Command.withExamples([
		{
			command: `infer fal run fal-ai/flux/schnell --input '{"prompt":"a red apple"}'`,
			description: "Generate an image and print the result JSON",
		},
		{
			command: `infer fal run fal-ai/flux/schnell --input '{"prompt":"a red apple"}' --output apple.jpg`,
			description: "Save the image straight to a file",
		},
		{
			command: `infer fal run fal-ai/flux/dev/image-to-image --input '{"prompt":"make it snowy","image_url":"./photo.jpg"}'`,
			description: "Pass a local file; it is uploaded first",
		},
		{
			command: `infer fal run fal-ai/flux/schnell --input '{"prompt":"a pear","num_images":3}' --output ./shots/`,
			description: "Save several assets into a directory",
		},
	]),
);

// --- cdn ------------------------------------------------------------------

const cdnCmd = Command.make(
	"cdn",
	{
		files: Argument.string("file").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"One or more local files to upload. Each URL is printed on its own line, in the order given.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const fal = yield* Fal;
			for (const file of config.files) {
				const url = yield* fal.upload(file);
				yield* Console.log(url);
			}
		}),
).pipe(
	Command.withShortDescription("Upload files to the fal CDN."),
	Command.withDescription(
		`Upload local files to the fal CDN and print their URLs.

Useful for reusing one asset across several runs, or for models
invoked outside this CLI. \`infer fal run\` does this automatically for
paths found in --input, so this is only needed to upload up front.

Files are uploaded under their basename, so the URL does not reveal
the local directory they came from.

Requires a fal.ai API key: run \`infer keys set\` or set FAL_KEY.`,
	),
	Command.withExamples([
		{ command: "infer fal cdn ./cat.png", description: "Upload a single file" },
		{
			command: "infer fal cdn ./a.png ./b.png",
			description: "Upload several files, one URL per line",
		},
	]),
);

export const falCmd = Command.make("fal").pipe(
	Command.withShortDescription("Search and run fal.ai models."),
	Command.withDescription(
		`Search, inspect and run fal.ai models.

A typical session: find a model with \`models\`, check what it accepts
with \`schema\`, then call it with \`run\`.

Model search works without credentials; running models and uploading
require a fal.ai API key.`,
	),
	Command.withSubcommands([modelsCmd, schemaCmd, runCmd, cdnCmd]),
);
