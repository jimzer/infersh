/**
 * fal.ai integration.
 *
 * The fal client is used for anything it covers (running models, CDN
 * uploads). The platform REST API it does not cover — model search and
 * OpenAPI schemas — goes through Effect's HttpClient.
 */

import { mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createFalClient, type FalClient } from "@fal-ai/client";
import { dereference } from "@readme/openapi-parser";
import { Console, Context, Data, Effect, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { JsonObject, lenient } from "./json.ts";
import { lazyKey, MissingKeyError, type Secrets } from "./secrets.ts";

const PLATFORM_API = "https://api.fal.ai/v1";
const SPEC_URL = "https://fal.ai/api/openapi/queue/openapi.json";

export class FalError extends Data.TaggedError("FalError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

// --- Model search ---------------------------------------------------------

/**
 * A model search response, declaring only the fields this CLI reads.
 *
 * Checked with `Schema.is` rather than decoded: decoding rebuilds the value
 * from the declared fields, and `--json` promises the full metadata.
 */
const ModelSummary = Schema.Struct({
	endpoint_id: Schema.String,
	metadata: Schema.optional(
		Schema.Struct({ category: Schema.optional(Schema.String) }),
	),
});
export type ModelSummary = typeof ModelSummary.Type;

const ModelSearchResult = Schema.Struct({
	models: Schema.Array(ModelSummary),
	next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
	has_more: Schema.Boolean,
});
export type ModelSearchResult = typeof ModelSearchResult.Type;

const isModelSearchResult = Schema.is(ModelSearchResult);

const ErrorBody = Schema.Struct({
	error: Schema.Struct({ message: Schema.String }),
});

export interface SearchParams {
	readonly q?: string;
	readonly category?: string;
	readonly status?: string;
	readonly limit?: number;
	readonly cursor?: string;
	readonly endpointIds: ReadonlyArray<string>;
	readonly expand: ReadonlyArray<string>;
}

/** Builds the query string, repeating keys for the array-valued params. */
export const searchQuery = (params: SearchParams): string => {
	const query = new URLSearchParams();
	if (params.q) query.set("q", params.q);
	if (params.category) query.set("category", params.category);
	if (params.status) query.set("status", params.status);
	if (params.limit !== undefined) query.set("limit", String(params.limit));
	if (params.cursor) query.set("cursor", params.cursor);
	for (const id of params.endpointIds) query.append("endpoint_id", id);
	for (const field of params.expand) query.append("expand", field);
	return query.toString();
};

// --- Model schema ---------------------------------------------------------

export interface InputSchema {
	readonly properties: Record<string, unknown>;
	readonly required: ReadonlyArray<string>;
}

const SubmitPath = Schema.Struct({
	post: Schema.Struct({
		requestBody: Schema.Struct({
			content: Schema.Struct({
				"application/json": Schema.Struct({
					schema: Schema.Struct({
						properties: Schema.optional(
							Schema.Record(Schema.String, Schema.Unknown),
						),
						required: Schema.optional(Schema.Array(Schema.String)),
					}),
				}),
			}),
		}),
	}),
});

const Spec = Schema.Struct({
	paths: Schema.Record(Schema.String, Schema.Unknown),
});

/**
 * Pulls the request body schema out of a model's OpenAPI document. Queue
 * management paths are skipped — only the submit endpoint takes model input.
 */
export const extractInputSchema = (spec: unknown): InputSchema | null => {
	const paths = Option.match(Schema.decodeUnknownOption(Spec)(spec), {
		onNone: () => [],
		onSome: (decoded) => Object.entries(decoded.paths),
	});
	for (const [path, methods] of paths) {
		if (path.includes("{request_id}")) continue;
		const submit = Schema.decodeUnknownOption(SubmitPath)(methods);
		if (Option.isNone(submit)) continue;
		const { schema } =
			submit.value.post.requestBody.content["application/json"];
		return {
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		};
	}
	return null;
};

export const specUrl = (endpointId: string): string =>
	`${SPEC_URL}?endpoint_id=${encodeURIComponent(endpointId)}`;

// --- Local asset uploading ------------------------------------------------

/**
 * Strings worth checking against the filesystem.
 *
 * Anything already addressable is left alone, and obviously-not-a-path values
 * (prompts with newlines, very long text) are skipped so a prompt is never
 * accidentally stat-ed as a filename.
 */
export const looksLikePath = (value: string): boolean => {
	if (value === "" || value.length > 4096) return false;
	if (value.includes("\n") || value.includes("\0")) return false;
	if (/^(https?|data|file|ftp):/i.test(value)) return false;
	return true;
};

/** Every candidate string in the payload, depth-first, without duplicates. */
export const collectCandidates = (input: unknown): ReadonlyArray<string> => {
	const found = new Set<string>();
	const walk = (node: unknown): void => {
		if (typeof node === "string") {
			if (looksLikePath(node)) found.add(node);
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (node !== null && typeof node === "object") {
			for (const value of Object.values(node)) walk(value);
		}
	};
	walk(input);
	return [...found];
};

/** Rebuilds the payload with uploaded paths replaced by their CDN URLs. */
export const substitute = (
	input: unknown,
	uploads: ReadonlyMap<string, string>,
): unknown => {
	if (typeof input === "string") return uploads.get(input) ?? input;
	if (Array.isArray(input))
		return input.map((item) => substitute(item, uploads));
	if (input !== null && typeof input === "object") {
		return Object.fromEntries(
			Object.entries(input).map(([key, value]) => [
				key,
				substitute(value, uploads),
			]),
		);
	}
	return input;
};

// --- Saving output assets -------------------------------------------------

export interface OutputAsset {
	readonly url: string;
	readonly fileName?: string;
	readonly contentType?: string;
}

/** How fal represents a produced file, wherever it appears in the output. */
const FileObject = Schema.Struct({
	url: Schema.String,
	file_name: lenient(Schema.String),
	content_type: lenient(Schema.String),
});

/**
 * Every produced asset, in the order the model returned them.
 *
 * fal represents files as objects carrying a `url` alongside `file_name` and
 * `content_type`, whatever the surrounding field is called (`images`, `video`,
 * `audio`). Matching on that shape avoids hard-coding a list of field names.
 */
export const collectOutputAssets = (
	output: unknown,
): ReadonlyArray<OutputAsset> => {
	const assets: OutputAsset[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (node === null || typeof node !== "object") return;

		const file = Schema.decodeUnknownOption(FileObject)(node);
		if (Option.isSome(file) && /^https?:\/\//i.test(file.value.url)) {
			assets.push({
				url: file.value.url,
				fileName: file.value.file_name,
				contentType: file.value.content_type,
			});
			// Do not descend into a file object; its fields are metadata.
			return;
		}
		for (const value of Object.values(node)) walk(value);
	};
	walk(output);
	return assets;
};

/** The trailing filename of a URL, ignoring any query string. */
export const urlFileName = (url: string): string | undefined => {
	try {
		const name = basename(new URL(url).pathname);
		return name === "" ? undefined : name;
	} catch {
		return undefined;
	}
};

/** Inserts `-2`, `-3`… before the extension: `out.png` -> `out-2.png`. */
const numbered = (path: string, index: number): string => {
	if (index === 0) return path;
	const dot = basename(path).lastIndexOf(".");
	if (dot <= 0) return `${path}-${index + 1}`;
	const cut = path.length - (basename(path).length - dot);
	return `${path.slice(0, cut)}-${index + 1}${path.slice(cut)}`;
};

/**
 * Where each asset should be written for a given `--output` target.
 *
 * A directory target keeps the model's own filenames; a file target is used
 * verbatim for a single asset and numbered when a model returns several.
 */
export const outputPaths = (
	target: string,
	assets: ReadonlyArray<OutputAsset>,
	targetIsDirectory: boolean,
): ReadonlyArray<string> =>
	assets.map((asset, index) => {
		if (targetIsDirectory) {
			const name =
				asset.fileName ?? urlFileName(asset.url) ?? `output-${index + 1}`;
			return join(target, name);
		}
		return numbered(target, index);
	});

/** fal validation errors carry the useful detail in a nested body. */
const ApiErrorDetail = Schema.Struct({
	body: Schema.Struct({ detail: Schema.Unknown }),
});

const describeFalError = (cause: unknown): string =>
	Option.match(Schema.decodeUnknownOption(ApiErrorDetail)(cause), {
		onNone: () => `${cause}`,
		onSome: ({ body }) =>
			body.detail ? JSON.stringify(body.detail) : `${cause}`,
	});

// --- The service ----------------------------------------------------------

export interface FalShape {
	/** Search, list or look up model endpoints on the platform API. */
	readonly searchModels: (
		params: SearchParams,
	) => Effect.Effect<ModelSearchResult, FalError>;
	/** A model's OpenAPI document, with every `$ref` resolved inline. */
	readonly fetchSpec: (endpointId: string) => Effect.Effect<unknown, FalError>;
	/** Upload one local file to the fal CDN, returning its URL. */
	readonly upload: (path: string) => Effect.Effect<string, FalError>;
	/** Replace local file paths anywhere in the payload with CDN URLs. */
	readonly resolveAssets: (input: unknown) => Effect.Effect<unknown, FalError>;
	/** Run a model to completion, returning its output payload. */
	readonly run: (
		endpointId: string,
		input: unknown,
	) => Effect.Effect<unknown, FalError>;
	/** Download every asset in a model output, returning the paths written. */
	readonly saveOutputs: (
		output: unknown,
		target: string,
	) => Effect.Effect<ReadonlyArray<string>, FalError>;
}

export class Fal extends Context.Service<Fal, FalShape>()("Fal") {}

const make = (options: {
	readonly http: HttpClient.HttpClient;
	/** Looked up on first use; see `lazyKey`. */
	readonly credentials: Effect.Effect<Option.Option<string>>;
}): FalShape => {
	const { http, credentials } = options;

	/** Anything that spends money or writes to the CDN needs a real key. */
	const requireCredentials = Effect.flatMap(
		credentials,
		Option.match({
			onNone: () =>
				Effect.fail(
					new FalError({
						reason: new MissingKeyError({ provider: "fal" }).message,
					}),
				),
			onSome: Effect.succeed,
		}),
	);

	/** A client carrying the key, for the calls that spend money or upload. */
	const requireClient: Effect.Effect<FalClient, FalError> = Effect.map(
		requireCredentials,
		(key) => createFalClient({ credentials: key }),
	);

	const upload: FalShape["upload"] = (path) =>
		Effect.gen(function* () {
			const client = yield* requireClient;
			return yield* Effect.tryPromise({
				try: async () => {
					const file = Bun.file(path);
					if (!(await file.exists())) throw new Error("file not found");
					// Rename to the basename: Bun.file() carries the whole path as its
					// name and fal bakes that into the public CDN URL, which would
					// otherwise publish the local directory structure.
					const named = new File([await file.arrayBuffer()], basename(path), {
						type: file.type,
					});
					return client.storage.upload(named);
				},
				catch: (cause) =>
					new FalError({ reason: `Could not upload ${path}: ${cause}` }),
			});
		});

	const resolveAssets: FalShape["resolveAssets"] = (input) =>
		Effect.gen(function* () {
			const existing = yield* Effect.tryPromise({
				try: async () => {
					const found: string[] = [];
					for (const value of collectCandidates(input)) {
						if (await Bun.file(value).exists()) found.push(value);
					}
					return found;
				},
				catch: (cause) =>
					new FalError({ reason: `Could not inspect input files: ${cause}` }),
			});
			if (existing.length === 0) return input;

			const uploads = new Map<string, string>();
			for (const path of existing) {
				const url = yield* upload(path);
				uploads.set(path, url);
				yield* Console.error(`uploaded ${path} -> ${url}`);
			}
			return substitute(input, uploads);
		});

	const download = (url: string, path: string): Effect.Effect<void, FalError> =>
		Effect.gen(function* () {
			const response = yield* http
				.get(url)
				.pipe(
					Effect.mapError(
						(cause) =>
							new FalError({ reason: `Could not download ${url}: ${cause}` }),
					),
				);
			if (response.status >= 400) {
				return yield* Effect.fail(
					new FalError({
						reason: `Could not download ${url}: ${response.status}`,
					}),
				);
			}
			const bytes = yield* response.arrayBuffer.pipe(
				Effect.mapError(
					(cause) =>
						new FalError({ reason: `Could not read ${url}: ${cause}` }),
				),
			);
			yield* Effect.tryPromise({
				try: async () => {
					mkdirSync(dirname(path), { recursive: true });
					await Bun.write(path, bytes);
				},
				catch: (cause) =>
					new FalError({ reason: `Could not write ${path}: ${cause}` }),
			});
		});

	return {
		searchModels: (params) =>
			Effect.gen(function* () {
				const query = searchQuery(params);
				const url = `${PLATFORM_API}/models${query ? `?${query}` : ""}`;
				const response = yield* http
					.get(url, {
						headers: {
							Accept: "application/json",
							// Optional: search works anonymously, just rate limited.
							...Option.match(yield* credentials, {
								onNone: () => ({}),
								onSome: (key) => ({ Authorization: `Key ${key}` }),
							}),
						},
					})
					.pipe(
						Effect.mapError(
							(cause) =>
								new FalError({ reason: `Model search failed: ${cause}` }),
						),
					);

				const body = yield* response.json.pipe(
					Effect.mapError(
						(cause) =>
							new FalError({
								reason: `Could not read the search response: ${cause}`,
							}),
					),
				);

				if (response.status >= 400) {
					const detail = Option.match(
						Schema.decodeUnknownOption(ErrorBody)(body),
						{
							onNone: () => JSON.stringify(body),
							onSome: ({ error }) => error.message,
						},
					);
					return yield* Effect.fail(
						new FalError({
							reason: `Model search failed (${response.status}): ${detail}`,
						}),
					);
				}
				if (!isModelSearchResult(body)) {
					return yield* Effect.fail(
						new FalError({
							reason: `Unexpected search response: ${JSON.stringify(body).slice(0, 300)}`,
						}),
					);
				}
				return body;
			}),

		fetchSpec: (endpointId) =>
			Effect.tryPromise({
				try: () => dereference(specUrl(endpointId)),
				catch: (cause) =>
					new FalError({
						reason: `Could not fetch the schema for ${endpointId}: ${cause}`,
					}),
			}),

		upload,
		resolveAssets,

		run: (endpointId, input) =>
			Effect.gen(function* () {
				const client = yield* requireClient;
				const payload = yield* Schema.decodeUnknownEffect(JsonObject)(
					input,
				).pipe(
					Effect.mapError(
						() => new FalError({ reason: "--input must be a JSON object." }),
					),
				);
				const result = yield* Effect.tryPromise({
					try: () =>
						client.subscribe(endpointId, {
							input: payload,
							logs: true,
							onQueueUpdate: (update) => {
								if (update.status === "IN_QUEUE") {
									process.stderr.write("[queue] waiting...\n");
								}
								if (update.status === "IN_PROGRESS") {
									for (const log of update.logs ?? []) {
										process.stderr.write(`${log.message}\n`);
									}
								}
							},
						}),
					catch: (cause) =>
						new FalError({
							reason: `${endpointId} failed: ${describeFalError(cause)}`,
						}),
				});
				return result.data;
			}),

		saveOutputs: (output, target) =>
			Effect.gen(function* () {
				const assets = collectOutputAssets(output);
				if (assets.length === 0) {
					return yield* Effect.fail(
						new FalError({
							reason:
								"The model returned no downloadable asset, so --output has nothing to write.\nRe-run without --output to see the raw result.",
						}),
					);
				}

				const isDirectory = yield* Effect.sync(() => {
					if (target.endsWith("/")) return true;
					try {
						return statSync(target).isDirectory();
					} catch {
						return false;
					}
				});

				const paths = outputPaths(target, assets, isDirectory);
				for (const [index, asset] of assets.entries()) {
					const path = paths[index];
					if (path !== undefined) yield* download(asset.url, path);
				}
				return paths;
			}),
	};
};

/**
 * The fal service. Its key is read only when a command first needs one.
 *
 * Clients come from `createFalClient` rather than the module-level `fal`
 * singleton, so the key is passed in instead of living in mutable global
 * state, and two differently-configured clients cannot interfere.
 */
export const layer: Layer.Layer<Fal, never, Secrets | HttpClient.HttpClient> =
	Layer.effect(Fal)(
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient;
			const credentials = yield* lazyKey("fal");
			return make({ http, credentials });
		}),
	);
