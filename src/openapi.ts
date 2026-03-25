/**
 * OpenAPI spec fetching and input schema extraction.
 * Uses @readme/openapi-parser for full $ref dereferencing.
 * Provider-agnostic — works with any OpenAPI 3.x spec.
 */

import { dereference } from "@readme/openapi-parser";
import type { SchemaObject } from "openapi3-ts/oas31";

export type { SchemaObject };

export interface InputSchema {
	properties: Record<string, SchemaObject>;
	required: string[];
}

/**
 * Fetch an OpenAPI spec and dereference all $refs inline.
 */
export async function fetchSpec(url: string) {
	return dereference(url);
}

/**
 * Extract the input schema from a dereferenced OpenAPI spec.
 * Finds the POST endpoint (skipping queue management paths) and
 * returns its request body schema. All $refs are already resolved.
 */
export function extractInputSchema(
	spec: Awaited<ReturnType<typeof fetchSpec>>,
): InputSchema {
	const paths = (spec as any).paths ?? {};
	for (const [path, methods] of Object.entries(paths) as [string, any][]) {
		if (path.includes("{request_id}")) continue;

		const post = methods.post;
		if (!post?.requestBody?.content?.["application/json"]?.schema) continue;

		const schema = post.requestBody.content["application/json"].schema;
		return {
			properties: (schema.properties ?? {}) as Record<string, SchemaObject>,
			required: schema.required ?? [],
		};
	}

	throw new Error("No POST endpoint with JSON request body found in spec");
}
