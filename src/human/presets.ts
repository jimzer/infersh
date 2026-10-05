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
import { basename, dirname } from "node:path";
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
	  }
	| {
			readonly kind: "upload";
			readonly prompt?: string;
			/** `accept` tokens, already split: `.pdf`, `image/*`. */
			readonly accept: ReadonlyArray<string>;
			readonly maxFiles?: number;
			readonly maxBytes?: number;
			/** Whether to offer a note beside the files. */
			readonly note: boolean;
	  }
	| {
			readonly kind: "download";
			readonly prompt?: string;
			/** The files on offer; each is fetched by its position here. */
			readonly files: ReadonlyArray<{
				readonly name: string;
				readonly size: number;
				readonly type: string;
			}>;
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

/**
 * Splits an `--accept` list the way the HTML attribute reads it; a bare `pdf`
 * is taken as `.pdf`.
 */
export const parseAccept = (text: string): ReadonlyArray<string> =>
	text
		.split(",")
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token !== "")
		.map((token) =>
			token.startsWith(".") || token.includes("/") ? token : `.${token}`,
		);

const UNITS: Readonly<Record<string, number>> = {
	"": 1,
	b: 1,
	k: 1024,
	kb: 1024,
	kib: 1024,
	m: 1024 ** 2,
	mb: 1024 ** 2,
	mib: 1024 ** 2,
	g: 1024 ** 3,
	gb: 1024 ** 3,
	gib: 1024 ** 3,
	t: 1024 ** 4,
	tb: 1024 ** 4,
	tib: 1024 ** 4,
};

/** `25MB`, `1.5 GB`, `500k` or plain bytes, in powers of 1024. */
export const parseSize = (text: string): number | undefined => {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
	const factor = UNITS[(match?.[2] ?? "").toLowerCase()];
	if (!match || factor === undefined) return undefined;
	const bytes = Math.floor(Number(match[1]) * factor);
	return bytes > 0 ? bytes : undefined;
};

/** `uploads/2026-10-02-1643`, in local time — the shape `meeting` uses. */
export const defaultUploadDir = (now: Date): string => {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `uploads/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
};

/** What the page server answers an upload with, once the files are saved. */
export const UploadAnswer = Schema.Struct({
	files: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			name: Schema.String,
			size: Schema.Finite,
			type: Schema.String,
		}),
	),
	note: Schema.optional(Schema.String),
});
export type UploadAnswer = typeof UploadAnswer.Type;

/** What the page server answers a download page with, however it ended. */
export const DownloadAnswer = Schema.Struct({
	downloaded: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			name: Schema.String,
			size: Schema.Finite,
		}),
	),
});
export type DownloadAnswer = typeof DownloadAnswer.Type;

/**
 * What Download all saves the archive as: the files' folder, when they share
 * one, as in `renders.zip`; otherwise `files.zip`.
 */
export const zipNameFor = (paths: ReadonlyArray<string>): string => {
	const folders = new Set(paths.map((path) => dirname(path)));
	const [only] = folders;
	const name = folders.size === 1 && only ? basename(only) : "";
	return `${name === "" || name === "/" ? "files" : name}.zip`;
};
