/**
 * The data side of `infer human`'s built-in pages: turning whatever list an
 * agent has into the items a page shows, and checking a form spec.
 *
 * Pure apart from reading local images, so the rules are tested without a
 * browser. The page itself is `page.tsx`, which is embedded as text and cannot
 * import this module, so the shapes below are restated there; `PresetData` is
 * what crosses over, as `infer.data`.
 */

import { existsSync, readFileSync } from "node:fs";
import { Option, Schema } from "effect";
import { JsonObject } from "../json.ts";
import { dataUri } from "../render-html.ts";

/** One thing to pick, approve or rank. */
export interface Item {
	/** What comes back in the answer: the `--id` field, or the item's position. */
	readonly id: string | number;
	readonly label: string;
	readonly detail?: string;
	/** An image URL, or a local file embedded as a data URI. */
	readonly image?: string;
}

/** Which fields of each item to show, and which to answer with. */
export interface ItemFields {
	readonly label?: string;
	readonly detail?: string;
	readonly image?: string;
	readonly id?: string;
}

export const FIELD_TYPES = [
	"text",
	"textarea",
	"number",
	"select",
	"checkbox",
] as const;

const FormField = Schema.Struct({
	name: Schema.NonEmptyString,
	label: Schema.optional(Schema.String),
	type: Schema.optional(Schema.Literals(FIELD_TYPES)),
	options: Schema.optional(Schema.Array(Schema.String)),
	required: Schema.optional(Schema.Boolean),
	placeholder: Schema.optional(Schema.String),
	default: Schema.optional(Schema.Unknown),
});
export type FormField = typeof FormField.Type;

/** A form spec: a list of fields, or `{ "fields": [...] }`. */
const FormSpec = Schema.Union([
	Schema.NonEmptyArray(FormField),
	Schema.Struct({ fields: Schema.NonEmptyArray(FormField) }),
]);

/** Everything a built-in page needs, delivered as `infer.data`. */
export type PresetData =
	| {
			readonly kind: "pick";
			readonly prompt?: string;
			readonly items: ReadonlyArray<Item>;
			readonly multi: boolean;
	  }
	| {
			readonly kind: "approve" | "rank";
			readonly prompt?: string;
			readonly items: ReadonlyArray<Item>;
	  }
	| { readonly kind: "edit"; readonly prompt?: string; readonly text: string }
	| {
			readonly kind: "form";
			readonly prompt?: string;
			readonly fields: ReadonlyArray<FormField>;
	  };

/** Anything shown as text: strings as they are, structures as indented JSON. */
const asText = (value: unknown): string | undefined =>
	value === undefined || value === null
		? undefined
		: typeof value === "string"
			? value
			: typeof value === "number" || typeof value === "boolean"
				? String(value)
				: JSON.stringify(value, null, 2);

/** A local image becomes a data URI, so the page carries it even when shared. */
const imageSource = (value: string): string =>
	!/^[a-z][a-z0-9+.-]*:/i.test(value) && existsSync(value)
		? dataUri(Bun.file(value).type, readFileSync(value))
		: value;

/**
 * Turns any JSON array into items, or explains what is wrong.
 *
 * Strings and numbers are their own label. Objects show the `label` field —
 * or, when none was named, their first string field — and answer with the
 * `id` field, or their position when none was named.
 */
export const toItems = (
	raw: ReadonlyArray<unknown>,
	fields: ItemFields,
): ReadonlyArray<Item> | string => {
	if (raw.length === 0) {
		return "--items is an empty list; there is nothing to show.";
	}
	const items: Item[] = [];
	for (const [index, entry] of raw.entries()) {
		const object = Schema.decodeUnknownOption(JsonObject)(entry);
		if (Option.isNone(object)) {
			items.push({ id: index, label: asText(entry) ?? "" });
			continue;
		}
		const record = object.value;
		for (const field of [fields.label, fields.id]) {
			if (field !== undefined && !(field in record)) {
				return `--items: item ${index} has no "${field}" field.`;
			}
		}
		const id = fields.id === undefined ? index : record[fields.id];
		if (typeof id !== "string" && typeof id !== "number") {
			return `--items: item ${index}'s "${fields.id}" must be a string or a number, to come back as its id.`;
		}
		const image =
			fields.image === undefined ? undefined : asText(record[fields.image]);
		items.push({
			id,
			label:
				(fields.label === undefined
					? undefined
					: asText(record[fields.label])) ??
				Object.values(record).find(
					(value): value is string => typeof value === "string",
				) ??
				JSON.stringify(record),
			detail:
				fields.detail === undefined ? undefined : asText(record[fields.detail]),
			image: image === undefined ? undefined : imageSource(image),
		});
	}
	if (new Set(items.map((item) => item.id)).size !== items.length) {
		return `--id "${fields.id}" is not unique across the items, so the answer could not tell them apart.`;
	}
	return items;
};

/** Reads a form spec, or explains what is wrong with it. */
export const parseFormFields = (
	raw: unknown,
): ReadonlyArray<FormField> | string =>
	Option.match(Schema.decodeUnknownOption(FormSpec)(raw), {
		onNone: () =>
			`--fields must be a non-empty array of fields like {"name":"email","type":"text","required":true}; type is one of ${FIELD_TYPES.join(", ")}.`,
		onSome: (spec) => {
			const fields = "fields" in spec ? spec.fields : spec;
			if (new Set(fields.map((field) => field.name)).size !== fields.length) {
				return "--fields has duplicate names.";
			}
			const empty = fields.find(
				(field) =>
					field.type === "select" && (field.options ?? []).length === 0,
			);
			return empty === undefined
				? fields
				: `--fields: "${empty.name}" is a select with no options.`;
		},
	});
