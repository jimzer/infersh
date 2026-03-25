/**
 * Dynamic CLI builder: OpenAPI schema properties -> Effect CLI Flags.
 * Provider-agnostic — takes any OpenAPI input schema.
 */

import { Option } from "effect";
import { Flag } from "effect/unstable/cli";
import type { SchemaObject } from "openapi3-ts/oas31";
import type { InputSchema } from "./openapi.ts";

interface ResolvedType {
	type: string;
	enum?: string[];
	default?: unknown;
	description?: string;
	nullable: boolean;
	items?: SchemaObject;
}

/**
 * Unwrap anyOf patterns like [{type: T}, {type: "null"}] into T (nullable).
 * Spec is already dereferenced so all entries are SchemaObject.
 */
function resolveType(prop: SchemaObject): ResolvedType {
	if (prop.anyOf) {
		const nonNull = prop.anyOf.filter(
			(v) => (v as SchemaObject).type !== "null",
		) as SchemaObject[];
		if (nonNull.length === 1 && nonNull[0]) {
			const inner = nonNull[0];
			return {
				type: (inner.type as string) ?? "string",
				enum: inner.enum as string[] | undefined,
				default: prop.default ?? inner.default,
				description: prop.description ?? inner.description,
				nullable: true,
				items: inner.items as SchemaObject | undefined,
			};
		}
	}
	return {
		type: (prop.type as string) ?? "string",
		enum: prop.enum as string[] | undefined,
		default: prop.default,
		description: prop.description,
		nullable: false,
		items: prop.items as SchemaObject | undefined,
	};
}

function toKebab(s: string): string {
	return s.replace(/_/g, "-");
}

/**
 * Check if array items are complex (objects) vs simple scalars.
 */
function isComplexItems(items: SchemaObject | undefined): boolean {
	if (!items) return false;
	return !!(items.type === "object" || items.properties);
}

/**
 * Build a human-readable JSON shape hint from an object schema.
 * e.g. '{"prompt": string, "duration": string}'
 */
function describeObjectShape(items: SchemaObject): string {
	if (!items.properties) return "object";
	const fields = Object.entries(items.properties)
		.map(([k, v]) => `"${k}": ${(v as SchemaObject).type ?? "string"}`)
		.join(", ");
	return `{${fields}}`;
}

export interface BuildFlagsResult {
	flags: Record<string, Flag.Flag<any>>;
	/** Field names whose string values should be JSON.parsed into the payload */
	jsonFields: Set<string>;
}

/**
 * Build an Effect CLI Flag record from an OpenAPI input schema.
 * Record keys = original property names (for payload reconstruction).
 * Flag CLI names = kebab-cased (for CLI convention).
 * All $refs must be pre-resolved (via openapi-parser dereference).
 */
export function buildFlags(schema: InputSchema): BuildFlagsResult {
	const flags: Record<string, Flag.Flag<any>> = {};
	const jsonFields = new Set<string>();
	const required = new Set(schema.required);

	for (const [name, rawProp] of Object.entries(schema.properties)) {
		const prop = resolveType(rawProp);
		const cli = toKebab(name);
		let flag: Flag.Flag<any>;

		if (rawProp.type === "array" || prop.type === "array") {
			const items = prop.items ?? (rawProp.items as SchemaObject | undefined);

			if (isComplexItems(items)) {
				// Complex array items — accept as JSON string
				jsonFields.add(name);
				const shape = items ? describeObjectShape(items) : "object";
				const desc = prop.description
					? `${prop.description} (JSON: [${shape}])`
					: `JSON array of ${shape}`;
				flag = Flag.string(cli).pipe(Flag.withDescription(desc));
				if (!required.has(name) || prop.nullable)
					flag = flag.pipe(Flag.optional);
			} else {
				// Simple array — repeatable flag
				flag = Flag.string(cli);
				if (prop.description)
					flag = flag.pipe(Flag.withDescription(prop.description));
				flag = flag.pipe(Flag.atLeast(required.has(name) ? 1 : 0));
			}
		} else if (prop.enum && prop.enum.length >= 2) {
			flag = Flag.choice(cli, prop.enum as [string, string, ...string[]]);
			if (prop.description)
				flag = flag.pipe(Flag.withDescription(prop.description));
			if (prop.default != null)
				flag = flag.pipe(Flag.withDefault(prop.default as string));
			else if (!required.has(name) || prop.nullable)
				flag = flag.pipe(Flag.optional);
		} else if (prop.type === "integer" || prop.type === "number") {
			flag = Flag.integer(cli);
			if (prop.description)
				flag = flag.pipe(Flag.withDescription(prop.description));
			if (prop.default != null)
				flag = flag.pipe(Flag.withDefault(prop.default as number));
			else if (!required.has(name) || prop.nullable)
				flag = flag.pipe(Flag.optional);
		} else if (prop.type === "boolean") {
			flag = Flag.boolean(cli);
			if (prop.description)
				flag = flag.pipe(Flag.withDescription(prop.description));
			flag = flag.pipe(Flag.withDefault((prop.default as boolean) ?? false));
		} else {
			flag = Flag.string(cli);
			if (prop.description)
				flag = flag.pipe(Flag.withDescription(prop.description));
			if (prop.default != null)
				flag = flag.pipe(Flag.withDefault(prop.default as string));
			else if (!required.has(name) || prop.nullable)
				flag = flag.pipe(Flag.optional);
		}

		flags[name] = flag;
	}

	return { flags, jsonFields };
}

/**
 * Convert parsed Effect CLI config to a JSON payload.
 * Unwraps Option values, strips undefined entries,
 * and JSON.parses fields that were complex arrays.
 */
export function configToPayload(
	config: Record<string, unknown>,
	jsonFields: Set<string>,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (Option.isOption(value)) {
			if (Option.isSome(value)) {
				payload[key] = jsonFields.has(key)
					? JSON.parse(value.value as string)
					: value.value;
			}
		} else if (value !== undefined) {
			payload[key] =
				jsonFields.has(key) && typeof value === "string"
					? JSON.parse(value)
					: value;
		}
	}
	return payload;
}

/**
 * Heuristic: field names that likely hold file URLs/paths.
 */
function isFileField(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower.includes("url") ||
		lower.includes("image") ||
		lower.includes("video") ||
		lower.includes("audio") ||
		lower.includes("file")
	);
}

/**
 * If the value is a local file path, upload it. Otherwise return as-is.
 */
async function maybeUpload(
	value: string,
	upload: (file: Blob) => Promise<string>,
): Promise<string> {
	if (
		value.startsWith("http://") ||
		value.startsWith("https://") ||
		value.startsWith("data:")
	) {
		return value;
	}
	const file = Bun.file(value);
	if (await file.exists()) {
		process.stderr.write(`Uploading ${value}...\n`);
		return upload(file);
	}
	return value;
}

/**
 * Walk the payload and upload local files for URL-ish fields.
 * Model-agnostic — detects file fields by name heuristic.
 */
export async function resolveLocalFiles(
	payload: Record<string, unknown>,
	upload: (file: Blob) => Promise<string>,
): Promise<Record<string, unknown>> {
	const resolved = { ...payload };
	for (const [key, value] of Object.entries(resolved)) {
		if (!isFileField(key)) continue;

		if (typeof value === "string") {
			resolved[key] = await maybeUpload(value, upload);
		} else if (Array.isArray(value)) {
			resolved[key] = await Promise.all(
				value.map((item) =>
					typeof item === "string" ? maybeUpload(item, upload) : item,
				),
			);
		}
	}
	return resolved;
}
