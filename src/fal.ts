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
import {
	Console,
	Context,
	Data,
	Effect,
	Layer,
	Option,
	Redacted,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { MissingKeyError, Secrets } from "./secrets.ts";

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

export interface ModelSummary {
	readonly endpoint_id: string;
	readonly metadata?: {
		readonly display_name?: string;
		readonly category?: string;
		readonly description?: string;
		readonly status?: string;
		readonly tags?: ReadonlyArray<string>;
	};
}

export interface ModelSearchResult {
	readonly models: ReadonlyArray<ModelSummary>;
	readonly next_cursor?: string | null;
	readonly has_more: boolean;
}

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

/**
 * Pulls the request body schema out of a model's OpenAPI document. Queue
 * management paths are skipped — only the submit endpoint takes model input.
 */
interface SpecPath {
	readonly post?: {
		readonly requestBody?: {
			readonly content?: Record<
				string,
				{
					readonly schema?: {
						readonly properties?: Record<string, unknown>;
						readonly required?: ReadonlyArray<string>;
					};
				}
			>;
		};
	};
}

export const extractInputSchema = (spec: unknown): InputSchema | null => {
	const paths =
		(spec as { paths?: Record<string, SpecPath> } | null)?.paths ?? {};
	for (const [path, methods] of Object.entries(paths)) {
		if (path.includes("{request_id}")) continue;
		const schema =
			methods?.post?.requestBody?.content?.["application/json"]?.schema;
		if (!schema) continue;
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

const isAssetUrl = (value: unknown): value is string =>
	typeof value === "string" && /^https?:\/\//i.test(value);

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

		const record = node as Record<string, unknown>;
		if (isAssetUrl(record.url)) {
			assets.push({
				url: record.url,
				fileName:
					typeof record.file_name === "string" ? record.file_name : undefined,
				contentType:
					typeof record.content_type === "string"
						? record.content_type
						: undefined,
			});
			// Do not descend into a file object; its fields are metadata.
			return;
		}
		for (const value of Object.values(record)) walk(value);
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
const describeFalError = (cause: unknown): string => {
	const body = (cause as { body?: { detail?: unknown } })?.body;
	if (body?.detail) return JSON.stringify(body.detail);
	return `${cause}`;
};

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
	readonly client: FalClient;
	readonly http: HttpClient.HttpClient;
	readonly credentials: Option.Option<string>;
}): FalShape => {
	const { client, http, credentials } = options;

	/** Anything that spends money or writes to the CDN needs a real key. */
	const requireCredentials = Option.isSome(credentials)
		? Effect.succeed(credentials.value)
		: Effect.fail(
				new FalError({
					reason: new MissingKeyError({ provider: "fal" }).message,
				}),
			);

	const upload: FalShape["upload"] = (path) =>
		Effect.gen(function* () {
			yield* requireCredentials;
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
							...(Option.isSome(credentials)
								? { Authorization: `Key ${credentials.value}` }
								: {}),
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
					const detail = (body as { error?: { message?: string } })?.error
						?.message;
					return yield* Effect.fail(
						new FalError({
							reason: `Model search failed (${response.status}): ${detail ?? JSON.stringify(body)}`,
						}),
					);
				}
				return body as unknown as ModelSearchResult;
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
				yield* requireCredentials;
				const result = yield* Effect.tryPromise({
					try: () =>
						client.subscribe(endpointId, {
							input: input as Record<string, unknown>,
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
 * Builds a fal client bound to the stored key.
 *
 * `createFalClient` is used rather than the module-level `fal` singleton so
 * credentials live in the layer instead of in mutable global state, which also
 * keeps two differently-configured clients from interfering.
 */
export const layer: Layer.Layer<Fal, never, Secrets | HttpClient.HttpClient> =
	Layer.effect(Fal)(
		Effect.gen(function* () {
			const secrets = yield* Secrets;
			const http = yield* HttpClient.HttpClient;
			const resolved = yield* secrets
				.get("fal")
				.pipe(Effect.orElseSucceed(Option.none));
			const credentials = Option.map(resolved, (r) => Redacted.value(r.key));
			const client = createFalClient({
				credentials: () => Option.getOrUndefined(credentials),
			});
			return make({ client, http, credentials });
		}),
	);
