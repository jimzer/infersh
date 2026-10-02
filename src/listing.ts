/**
 * Compact shapes for listing commands, and `--fields` projection.
 *
 * Bright Data's records carry dozens of fields — a ChatGPT answer arrives with
 * three quarters of a megabyte of page HTML, a YouTube video with its full
 * transcript twice over. An agent listing results wants a handful of them.
 *
 * Each shape is a Schema over the provider's own keys, which keeps only the
 * fields it declares (decoding strips the rest, at every depth), and a rename
 * table giving those fields short, consistent names. Every field is `lenient`,
 * so one odd value costs that field rather than the record. See
 * `docs/adrs/0029`.
 */

import { Option, Predicate, Schema, Struct } from "effect";
import { JsonObject, lenient } from "./json.ts";

const Text = lenient(Schema.String);
const Count = lenient(Schema.Finite);

/** A compact shape: which provider fields to keep, and what to call them. */
export interface Shape {
	/** One result, as `--help` shows it: `{title, url, …}`. */
	readonly summary: string;
	/** The compact record, or `None` when the row is not an object. */
	readonly compact: (row: unknown) => Option.Option<Record<string, unknown>>;
}

/** A field decodable without services, which every lenient field is. */
type Field = Schema.Top & { readonly DecodingServices: never };

const shape = (
	fields: Readonly<Record<string, Field>>,
	renames: Readonly<Record<string, string>>,
	refine: (record: Record<string, unknown>) => Record<string, unknown> = (
		record,
	) => record,
): Shape => {
	const decode = Schema.decodeUnknownOption(Schema.Struct(fields));
	const names = Object.keys(fields).map((key) => renames[key] ?? key);
	return {
		summary: `{${names.join(", ")}}`,
		compact: (row) =>
			Option.map(decode(row), (record) =>
				refine(Struct.renameKeys(record, renames)),
			),
	};
};

/**
 * A row Bright Data could not collect — a deleted post, a dead link.
 *
 * Kept whatever the shape, so a failure is never compacted into an empty
 * record that looks like a result with nothing in it.
 */
const ErrorRow = Schema.Struct({
	error: Schema.String,
	error_code: Text,
	input: lenient(JsonObject),
});
const decodeErrorRow = Schema.decodeUnknownOption(ErrorRow);

export const YOUTUBE_VIDEO = shape(
	{
		title: Text,
		url: Text,
		handle_name: Text,
		views: Count,
		likes: Count,
		date_posted: Text,
		video_length: Count,
	},
	{
		handle_name: "channel",
		date_posted: "published",
		video_length: "duration",
	},
);

export const YOUTUBE_COMMENT = shape(
	{
		comment_text: Text,
		username: Text,
		likes: Count,
		replies: Count,
		date_iso: Text,
	},
	{ comment_text: "text", username: "author", date_iso: "date" },
);

export const X_POST = shape(
	{
		description: Text,
		url: Text,
		user_posted: Text,
		date_posted: Text,
		likes: Count,
		reposts: Count,
		replies: Count,
		views: Count,
	},
	{ description: "text", user_posted: "author", date_posted: "date" },
);

export const REDDIT_POST = shape(
	{
		title: Text,
		url: Text,
		community_name: Text,
		user_posted: Text,
		date_posted: Text,
		num_upvotes: Count,
		num_comments: Count,
		description: Text,
	},
	{
		community_name: "community",
		user_posted: "author",
		date_posted: "date",
		num_upvotes: "score",
		num_comments: "comments",
		description: "text",
	},
);

export const REDDIT_COMMENT = shape(
	{
		comment: Text,
		user_posted: Text,
		date_posted: Text,
		num_upvotes: Count,
		num_replies: Count,
		url: Text,
	},
	{
		comment: "text",
		user_posted: "author",
		date_posted: "date",
		num_upvotes: "score",
		num_replies: "replies",
	},
);

export const LINKEDIN_POST = shape(
	{
		post_text: Text,
		url: Text,
		user_name: Text,
		date_posted: Text,
		num_likes: Count,
		num_comments: Count,
		post_type: Text,
	},
	{
		post_text: "text",
		user_name: "author",
		date_posted: "date",
		num_likes: "likes",
		num_comments: "comments",
		post_type: "type",
	},
);

export const LINKEDIN_JOB = shape(
	{
		job_title: Text,
		company_name: Text,
		job_location: Text,
		url: Text,
		job_posted_date: Text,
		job_employment_type: Text,
		job_seniority_level: Text,
		base_salary: lenient(JsonObject),
	},
	{
		job_title: "title",
		company_name: "company",
		job_location: "location",
		job_posted_date: "posted",
		job_employment_type: "type",
		job_seniority_level: "seniority",
		base_salary: "salary",
	},
);

const Citation = Schema.Struct({ title: Text, url: Text });

export const CHATGPT_ANSWER = shape(
	{
		prompt: Text,
		answer_text_markdown: Text,
		citations: lenient(Schema.Array(Citation)),
		model: Text,
		additional_prompt: Text,
		additional_answer_text: Text,
	},
	{
		answer_text_markdown: "answer",
		additional_prompt: "followUp",
		additional_answer_text: "followUpAnswer",
	},
	// Without a follow-up, the follow-up answer is filler such as "ChatGPT
	// said: No internet", not an answer to anything.
	({ followUpAnswer, ...record }) =>
		record.followUp === undefined ? record : { ...record, followUpAnswer },
);

/**
 * Compacts a dataset result: an array of rows, or one row on its own when
 * Bright Data answered a single-row job inline.
 *
 * Error rows are kept as `{error, errorCode, input}`. Anything that is not an
 * object passes through untouched rather than being dropped.
 */
export const compactRecords = (shape: Shape, result: unknown): unknown => {
	const one = (row: unknown): unknown =>
		Option.match(decodeErrorRow(row), {
			onSome: (failed) =>
				Struct.renameKeys(failed, { error_code: "errorCode" } as const),
			onNone: () => Option.getOrElse(shape.compact(row), () => row),
		});
	return Array.isArray(result) ? result.map(one) : one(result);
};

// --- search ---------------------------------------------------------------

export const SEARCH_RESULT_SUMMARY = "{title, url, snippet, date}";

const Organic = Schema.Struct({
	title: Text,
	link: Text,
	description: Text,
	extensions: lenient(Schema.Array(Schema.Unknown)),
});

/** Google's or Bing's parsed SERP, as `brd_json=1` returns it. */
const Serp = Schema.Struct({ organic: Schema.Array(Schema.Unknown) });

/** `--format json` wraps the same SERP as a JSON string in `body`. */
const SerpEnvelope = Schema.Struct({ body: Schema.fromJsonString(Serp) });

const TextExtension = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
});

/**
 * The publish date Google shows under a result.
 *
 * Bright Data has no date field on an organic result; Google's "23 Mar 2026"
 * or "3 days ago" arrives as a `text` extension, alongside other text
 * extensions that are not dates. A year or "ago" is what tells them apart.
 */
const dateOf = (
	extensions: ReadonlyArray<unknown> | undefined,
): string | undefined =>
	(extensions ?? [])
		.flatMap((extension) =>
			Option.toArray(Schema.decodeUnknownOption(TextExtension)(extension)),
		)
		.map((extension) => extension.text)
		.find((text) => /\b(19|20)\d{2}\b|\bago\b/i.test(text));

const decodeOrganic = Schema.decodeUnknownOption(Organic);

/**
 * The first `limit` organic results of one search, as
 * `{title, url, snippet, date}`, or `None` when the result is not a parsed
 * SERP — a Yandex page, or a `--data-format` other than the default.
 */
export const compactSerp = (
	result: unknown,
	limit = Number.POSITIVE_INFINITY,
): Option.Option<ReadonlyArray<Record<string, unknown>>> =>
	Schema.decodeUnknownOption(Serp)(result).pipe(
		Option.orElse(() =>
			Option.map(
				Schema.decodeUnknownOption(SerpEnvelope)(result),
				(envelope) => envelope.body,
			),
		),
		Option.map((serp) =>
			serp.organic.slice(0, limit).flatMap((item) =>
				Option.toArray(
					Option.map(decodeOrganic(item), (organic) => {
						const record: Record<string, unknown> = {
							title: organic.title,
							url: organic.link,
							snippet: organic.description,
							date: dateOf(organic.extensions),
						};
						return Object.fromEntries(
							Object.entries(record).filter(([, value]) => value !== undefined),
						);
					}),
				),
			),
		),
	);

// --- --fields --------------------------------------------------------------

/** `--fields title, url,,date` → `["title", "url", "date"]`. */
export const parseFields = (text: string): ReadonlyArray<string> =>
	text
		.split(",")
		.map((field) => field.trim())
		.filter((field) => field !== "");

interface FieldTree extends Map<string, FieldTree> {}

const fieldTree = (paths: ReadonlyArray<string>): FieldTree => {
	const root: FieldTree = new Map();
	for (const path of paths) {
		let node = root;
		for (const segment of path.split(".")) {
			const next: FieldTree = node.get(segment) ?? new Map();
			node.set(segment, next);
			node = next;
		}
	}
	return root;
};

/** Keys every row keeps when present, so a failed row still says why. */
const ALWAYS_KEPT = ["error", "errorCode", "error_code"];

type JsonRecord = { readonly [key: PropertyKey]: unknown };

const pickObject = (
	value: JsonRecord,
	tree: FieldTree,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [key, subtree] of tree) {
		if (key in value) out[key] = pick(value[key], subtree);
	}
	return out;
};

const pick = (value: unknown, tree: FieldTree): unknown => {
	if (tree.size === 0) return value;
	if (Array.isArray(value)) return value.map((item) => pick(item, tree));
	return Predicate.isObject(value) ? pickObject(value, tree) : value;
};

/**
 * Keeps only the named fields of each row: of every element when `result` is
 * an array, of the value itself when it is one row.
 *
 * A dotted path reaches into nested objects, and through arrays element by
 * element: `citations.url` keeps the URL of every citation. A field a row does
 * not have is left out rather than set to `null`.
 */
export const projectFields = (
	result: unknown,
	fields: ReadonlyArray<string>,
): unknown => {
	const tree = fieldTree(fields);
	const row = (value: unknown): unknown => {
		if (!Predicate.isObject(value)) return value;
		const kept = pickObject(value, tree);
		for (const key of ALWAYS_KEPT) {
			if (key in value && !(key in kept)) kept[key] = value[key];
		}
		return kept;
	};
	return Array.isArray(result) ? result.map(row) : row(result);
};

/**
 * Requested fields that no row has at the top level — almost always a typo or
 * a raw key asked of the compact shape — or nothing when there are no rows to
 * judge by.
 */
export const missingFields = (
	result: unknown,
	fields: ReadonlyArray<string>,
): {
	readonly missing: ReadonlyArray<string>;
	readonly available: ReadonlyArray<string>;
} => {
	const rows = (Array.isArray(result) ? result : [result]).filter(
		Predicate.isObject,
	);
	const available = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	const missing =
		rows.length === 0
			? []
			: fields.filter(
					(field) => !available.includes(field.split(".")[0] ?? field),
				);
	return { missing, available };
};
