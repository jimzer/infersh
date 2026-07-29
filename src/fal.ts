/**
 * fal.ai integration.
 *
 * The fal client is used for anything it covers (running models, CDN
 * uploads). The platform REST API it does not cover — model search and
 * OpenAPI schemas — goes through Effect's HttpClient.
 */

import { basename } from "node:path";
import { fal } from "@fal-ai/client";
import { dereference } from "@readme/openapi-parser";
import { Console, Data, Effect, Option, Redacted } from "effect";
import { HttpClient } from "effect/unstable/http";
import { Secrets } from "./secrets.ts";

const PLATFORM_API = "https://api.fal.ai/v1";
const SPEC_URL = "https://fal.ai/api/openapi/queue/openapi.json";

export class FalError extends Data.TaggedError("FalError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

// --- Authentication -------------------------------------------------------

/**
 * Points the fal client at the stored key. Required for running models and
 * uploading; model search works unauthenticated but is rate limited.
 */
export const configureClient = Effect.gen(function* () {
	const secrets = yield* Secrets;
	const key = yield* secrets.require("fal");
	fal.config({ credentials: Redacted.value(key) });
});

/** The key if we have one, ignoring "not set" — search tolerates anonymity. */
const optionalKey = Effect.gen(function* () {
	const secrets = yield* Secrets;
	const resolved = yield* secrets
		.get("fal")
		.pipe(Effect.orElseSucceed(Option.none));
	return Option.map(resolved, (r) => Redacted.value(r.key));
});

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

export const searchModels = (
	params: SearchParams,
): Effect.Effect<
	ModelSearchResult,
	FalError,
	Secrets | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const key = yield* optionalKey;
		const query = searchQuery(params);
		const url = `${PLATFORM_API}/models${query ? `?${query}` : ""}`;

		const response = yield* HttpClient.get(url, {
			headers: {
				Accept: "application/json",
				...(Option.isSome(key) ? { Authorization: `Key ${key.value}` } : {}),
			},
		}).pipe(
			Effect.mapError(
				(cause) => new FalError({ reason: `Model search failed: ${cause}` }),
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
			const detail = (body as { error?: { message?: string } })?.error?.message;
			return yield* Effect.fail(
				new FalError({
					reason: `Model search failed (${response.status}): ${detail ?? JSON.stringify(body)}`,
				}),
			);
		}

		return body as unknown as ModelSearchResult;
	});

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

/** Fetches a model's OpenAPI document with every `$ref` resolved inline. */
export const fetchSpec = (
	endpointId: string,
): Effect.Effect<unknown, FalError> =>
	Effect.tryPromise({
		try: () => dereference(specUrl(endpointId)),
		catch: (cause) =>
			new FalError({
				reason: `Could not fetch the schema for ${endpointId}: ${cause}`,
			}),
	});

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

/**
 * Uploads a single file and returns its CDN URL.
 *
 * The blob is renamed to the file's basename first: `Bun.file()` carries the
 * whole path as its name, and fal bakes that name into the CDN URL, which
 * would otherwise leak the full local directory structure into a public link.
 */
export const uploadFile = (path: string): Effect.Effect<string, FalError> =>
	Effect.tryPromise({
		try: async () => {
			const file = Bun.file(path);
			if (!(await file.exists())) throw new Error("file not found");
			const named = new File([await file.arrayBuffer()], basename(path), {
				type: file.type,
			});
			return fal.storage.upload(named);
		},
		catch: (cause) =>
			new FalError({ reason: `Could not upload ${path}: ${cause}` }),
	});

/**
 * Finds local file paths anywhere in the payload, uploads them, and returns
 * the payload with those paths replaced by CDN URLs.
 */
export const resolveAssets = (
	input: unknown,
): Effect.Effect<unknown, FalError> =>
	Effect.gen(function* () {
		const candidates = yield* Effect.tryPromise({
			try: async () => {
				const existing: string[] = [];
				for (const value of collectCandidates(input)) {
					if (await Bun.file(value).exists()) existing.push(value);
				}
				return existing;
			},
			catch: (cause) =>
				new FalError({ reason: `Could not inspect input files: ${cause}` }),
		});

		if (candidates.length === 0) return input;

		const uploads = new Map<string, string>();
		for (const path of candidates) {
			const url = yield* uploadFile(path);
			uploads.set(path, url);
			yield* Console.error(`uploaded ${path} -> ${url}`);
		}
		return substitute(input, uploads);
	});

// --- Running a model ------------------------------------------------------

export const runModel = (
	endpointId: string,
	input: unknown,
): Effect.Effect<unknown, FalError> =>
	Effect.tryPromise({
		try: () =>
			fal.subscribe(endpointId, {
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
	}).pipe(Effect.map((result) => result.data));

/** fal validation errors carry the useful detail in a nested body. */
const describeFalError = (cause: unknown): string => {
	const body = (cause as { body?: { detail?: unknown } })?.body;
	if (body?.detail) return JSON.stringify(body.detail);
	return `${cause}`;
};
