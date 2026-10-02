/**
 * `infer human` — ask the human: show them a page and wait for what they do.
 */

import { resolve } from "node:path";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
// The built-in page, embedded as text and served as an inline source: Bun
// inlines the characters without following its imports, so React stays out
// of the CLI. Being text for the whole build, it must never be imported
// normally.
// @ts-expect-error text import: Bun inlines the file contents as a string
import pageSource from "../human/page.tsx" with { type: "text" };
import {
	FIELD_TYPES,
	type Item,
	type PresetData,
	parseFormFields,
	toItems,
} from "../human/presets.ts";
import { JsonText } from "../json.ts";
import { emitJson, jsonFlag } from "../output.ts";
import { Ui, UiError, type UiRequest, type UiResult } from "../ui.ts";

const PAGE_SOURCE: string = pageSource;

const APP_NOTE =
	"Path to a .tsx file that renders the page into #root. Relative imports of other files are inlined automatically; package imports such as react are installed on demand, so nothing has to be set up first.";

/** Reads a file named by a flag, failing with the flag's name in the message. */
const readNamedFile = (
	path: string,
	flag: string,
): Effect.Effect<string, UiError> =>
	Effect.tryPromise({
		try: async () => {
			const file = Bun.file(resolve(path));
			if (!(await file.exists())) throw new Error(`file not found: ${path}`);
			return file.text();
		},
		catch: (cause) =>
			new UiError({ reason: `Could not read ${flag}: ${cause}` }),
	});

/** Inline JSON, or a path to a JSON file — the same rule as `render --props`. */
const loadJson = (
	value: string,
	flag: string,
): Effect.Effect<unknown, UiError> =>
	Effect.gen(function* () {
		const trimmed = value.trimStart();
		const raw =
			trimmed.startsWith("{") || trimmed.startsWith("[")
				? value
				: yield* readNamedFile(value, flag);
		return yield* Schema.decodeUnknownEffect(JsonText)(raw).pipe(
			Effect.mapError(
				() => new UiError({ reason: `${flag} is not valid JSON.` }),
			),
		);
	});

const resolveData = (
	data: Option.Option<string>,
): Effect.Effect<unknown, UiError> =>
	Option.isNone(data)
		? Effect.succeed(undefined)
		: loadJson(data.value, "--data");

const sharedFlags = {
	data: Flag.String("data").pipe(
		Flag.withMetavar("json|path"),
		Flag.optional,
		Flag.withDescription(
			"Content for the page, as inline JSON or a path to a .json file. Reaches the page as infer.data. Keeping the content here rather than inside the .tsx is what lets one page be reused across runs.",
		),
	),
	title: Flag.String("title").pipe(
		Flag.withMetavar("text"),
		Flag.optional,
		Flag.withDescription("Browser tab title. Defaults to the file name."),
	),
	timeout: Flag.Int("timeout").pipe(
		Flag.withMetavar("seconds"),
		Flag.optional,
		Flag.withDescription(
			"How long to wait before giving up. On expiry the command still exits 0 with status timeout, which means the user never answered — say so rather than assuming anything.",
		),
	),
	port: Flag.Int("port").pipe(
		Flag.withMetavar("n"),
		Flag.optional,
		Flag.withDescription(
			"Pin the port. Defaults to a free one chosen by the OS, so parallel runs never collide.",
		),
	),
	share: Flag.Boolean("share").pipe(
		Flag.withDefault(false),
		Flag.withDescription(
			"Also publish the page on your tailnet over HTTPS, for opening it on another device such as a phone. Off by default: without it the page is on localhost, which is all you need at this computer. Needs Tailscale; the share ends with the command and leaves other `tailscale serve` rules alone.",
		),
	),
	open: Flag.Boolean("open").pipe(
		Flag.withDefault(false),
		Flag.withDescription(
			"Open the URL in the local browser as well as printing it.",
		),
	),
	noTailwind: Flag.Boolean("no-tailwind").pipe(
		Flag.withDefault(false),
		Flag.withDescription(
			"Skip Tailwind. Tailwind v4 is inlined by default, so a page can be styled with class names alone and needs no network.",
		),
	),
	head: Flag.String("head").pipe(
		Flag.withMetavar("html"),
		Flag.optional,
		Flag.withDescription(
			"Extra HTML injected into <head>, e.g. a font <link>.",
		),
	),
	json: jsonFlag,
};

type SharedFlags = {
	readonly data: Option.Option<string>;
	readonly title: Option.Option<string>;
	readonly timeout: Option.Option<number>;
	readonly port: Option.Option<number>;
	readonly share: boolean;
	readonly open: boolean;
	readonly noTailwind: boolean;
	readonly head: Option.Option<string>;
};

/** What each ending means, said plainly, because a status alone gets skimmed. */
const NOTE: Record<UiResult["status"], string> = {
	submitted: "Answered.",
	done: "Seen.",
	cancelled: "Cancelled — the user declined rather than not answering.",
	timeout: "Timed out. The user never answered; do not assume they agreed.",
};

const runPage = (
	app: string,
	mode: UiRequest["mode"],
	flags: SharedFlags,
	defaultTimeout: number,
) =>
	Effect.gen(function* () {
		const ui = yield* Ui;
		const data = yield* resolveData(flags.data);
		const result = yield* ui.run({
			app: { path: app },
			mode,
			data,
			title: Option.getOrElse(
				flags.title,
				() => app.split("/").pop() ?? "infer",
			),
			timeoutMs: Option.getOrElse(flags.timeout, () => defaultTimeout) * 1000,
			port: Option.getOrElse(flags.port, () => 0),
			share: flags.share,
			tailwind: !flags.noTailwind,
			head: Option.getOrUndefined(flags.head),
			open: flags.open,
		});
		yield* Console.error(`  ${NOTE[result.status]}`);
		// stdout is always JSON: the payload's shape is decided by the page, so
		// there is no human rendering of it this command could know how to do.
		yield* emitJson(result);
	});

const askCmd = Command.make(
	"ask",
	{
		app: Argument.String("app.tsx").pipe(Argument.withDescription(APP_NOTE)),
		...sharedFlags,
	},
	(flags) => runPage(flags.app, "ask", flags, 300),
).pipe(
	Command.withShortDescription("Serve a page you write and get its answer."),
	Command.withDescription(
		"Serve a page, wait for the user to answer through it, and print their answer. The page calls infer.submit(anything) with whatever JSON it likes; that value comes back as payload, untouched. Blocks until the user acts or the timeout expires.",
	),
);

const presentCmd = Command.make(
	"present",
	{
		app: Argument.String("app.tsx").pipe(Argument.withDescription(APP_NOTE)),
		...sharedFlags,
	},
	(flags) => runPage(flags.app, "present", flags, 900),
).pipe(
	Command.withShortDescription(
		"Show a page you write and wait until it has been read.",
	),
	Command.withDescription(
		"Show the user a page and wait until they have read it. A Done button is added automatically, so the page needs no submit logic at all. Blocks until they click it, which makes it a review gate rather than a notification.",
	),
);

// --- built-in pages ---------------------------------------------------------

/** The flags that decide how and where a page is served, without the content. */
const servingFlags = {
	title: sharedFlags.title,
	timeout: sharedFlags.timeout,
	port: sharedFlags.port,
	share: sharedFlags.share,
	open: sharedFlags.open,
	json: jsonFlag,
};

type ServingFlags = Pick<
	SharedFlags,
	"title" | "timeout" | "port" | "share" | "open"
>;

const promptFlag = Flag.String("prompt").pipe(
	Flag.withMetavar("text"),
	Flag.optional,
	Flag.withDescription(
		"The question, shown at the top of the page. Say what the choice is for.",
	),
);

const itemFlags = {
	items: Flag.String("items").pipe(
		Flag.withMetavar("json|path"),
		Flag.withDescription(
			"The list to show: a JSON array, inline or as a path to a .json file. Strings and numbers are shown as they are; objects show the --label field, or their first string field.",
		),
	),
	label: Flag.String("label").pipe(
		Flag.withMetavar("field"),
		Flag.optional,
		Flag.withDescription("Field of each item to show as its title."),
	),
	detail: Flag.String("detail").pipe(
		Flag.withMetavar("field"),
		Flag.optional,
		Flag.withDescription(
			"Field of each item to show beneath the title, line breaks kept.",
		),
	),
	image: Flag.String("image").pipe(
		Flag.withMetavar("field"),
		Flag.optional,
		Flag.withDescription(
			"Field of each item holding an image: a URL, or a local path, which is embedded so the page carries it.",
		),
	),
	id: Flag.String("id").pipe(
		Flag.withMetavar("field"),
		Flag.optional,
		Flag.withDescription(
			"Field of each item to answer with. Defaults to each item's position in the list, counting from 0.",
		),
	),
	prompt: promptFlag,
};

type ItemFlags = {
	readonly items: string;
	readonly label: Option.Option<string>;
	readonly detail: Option.Option<string>;
	readonly image: Option.Option<string>;
	readonly id: Option.Option<string>;
	readonly prompt: Option.Option<string>;
};

const loadItems = (
	flags: ItemFlags,
): Effect.Effect<ReadonlyArray<Item>, UiError> =>
	Effect.gen(function* () {
		const raw = yield* loadJson(flags.items, "--items").pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))),
			Effect.mapError((error) =>
				error._tag === "UiError"
					? error
					: new UiError({ reason: "--items must be a JSON array." }),
			),
		);
		const items = toItems(raw, {
			label: Option.getOrUndefined(flags.label),
			detail: Option.getOrUndefined(flags.detail),
			image: Option.getOrUndefined(flags.image),
			id: Option.getOrUndefined(flags.id),
		});
		return typeof items === "string"
			? yield* Effect.fail(new UiError({ reason: items }))
			: items;
	});

/** Serves the built-in page with `data`, and prints the answer like `ask`. */
const runPreset = (data: PresetData, flags: ServingFlags) =>
	Effect.gen(function* () {
		const ui = yield* Ui;
		const result = yield* ui.run({
			app: { inline: PAGE_SOURCE },
			mode: "ask",
			data,
			title: Option.getOrElse(
				flags.title,
				() => data.prompt ?? `infer ${data.kind}`,
			),
			timeoutMs: Option.getOrElse(flags.timeout, () => 900) * 1000,
			port: Option.getOrElse(flags.port, () => 0),
			share: flags.share,
			tailwind: true,
			open: flags.open,
		});
		yield* Console.error(`  ${NOTE[result.status]}`);
		yield* emitJson(result);
	});

const ANSWER_NOTE =
	"Prints the same JSON as ask: {status, payload, elapsedMs, url}. Only a status of submitted carries an answer; cancelled means they declined, timeout that they never answered.";

const pickCmd = Command.make(
	"pick",
	{
		...itemFlags,
		multi: Flag.Boolean("multi").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Allow picking several. Without it, exactly one."),
		),
		...servingFlags,
	},
	(flags) =>
		Effect.gen(function* () {
			const items = yield* loadItems(flags);
			yield* runPreset(
				{
					kind: "pick",
					prompt: Option.getOrUndefined(flags.prompt),
					items,
					multi: flags.multi,
				},
				flags,
			);
		}),
).pipe(
	Command.withShortDescription("Let the human pick one item, or several."),
	Command.withDescription(
		`Show a list and let the human pick one item, or several with --multi.

payload: {"picked": [<id>, ...]} — always an array, in the list's order,
with one entry unless --multi. An id is the --id field, or the item's
position. Long lists get a filter box.

${ANSWER_NOTE}`,
	),
	Command.withExamples([
		{
			command:
				"infer human pick --items drafts.json --label title --detail body --multi --prompt 'Which should I post?'",
			description: "Keep some drafts",
		},
		{
			command: `infer human pick --items '["Postgres","SQLite","DuckDB"]' --prompt 'Which database?'`,
			description: "Choose one of a few strings",
		},
	]),
);

const approveCmd = Command.make(
	"approve",
	{ ...itemFlags, ...servingFlags },
	(flags) =>
		Effect.gen(function* () {
			const items = yield* loadItems(flags);
			yield* runPreset(
				{ kind: "approve", prompt: Option.getOrUndefined(flags.prompt), items },
				flags,
			);
		}),
).pipe(
	Command.withShortDescription("Let the human approve or reject each item."),
	Command.withDescription(
		`Show a list and have the human approve or reject every item, with an
optional note on each. Submitting needs a verdict on every item.

payload: {"decisions": [{"id": <id>, "approved": true|false, "note"?: "..."}]}
— one per item, in the list's order.

${ANSWER_NOTE}`,
	),
	Command.withExamples([
		{
			command:
				"infer human approve --items findings.json --label title --detail why --id key --prompt 'Fix these?'",
			description: "Triage review findings",
		},
	]),
);

const rankCmd = Command.make(
	"rank",
	{ ...itemFlags, ...servingFlags },
	(flags) =>
		Effect.gen(function* () {
			const items = yield* loadItems(flags);
			yield* runPreset(
				{ kind: "rank", prompt: Option.getOrUndefined(flags.prompt), items },
				flags,
			);
		}),
).pipe(
	Command.withShortDescription("Let the human put items in order."),
	Command.withDescription(
		`Show a list and have the human put it in order, best first. Items move
with up and down buttons, which work on a phone as well as a desktop.

payload: {"order": [<id>, ...]} — every id, in the order they chose.

${ANSWER_NOTE}`,
	),
	Command.withExamples([
		{
			command:
				"infer human rank --items titles.json --prompt 'Rank these titles'",
			description: "Order candidate titles",
		},
	]),
);

const editCmd = Command.make(
	"edit",
	{
		text: Flag.String("text").pipe(
			Flag.withMetavar("text|path"),
			Flag.withDescription(
				"The text to edit: a path to a file, or the text itself when no such file exists.",
			),
		),
		prompt: promptFlag,
		...servingFlags,
	},
	(flags) =>
		Effect.gen(function* () {
			const text = (yield* Effect.promise(() =>
				Bun.file(resolve(flags.text)).exists(),
			))
				? yield* readNamedFile(flags.text, "--text")
				: flags.text;
			yield* runPreset(
				{ kind: "edit", prompt: Option.getOrUndefined(flags.prompt), text },
				flags,
			);
		}),
).pipe(
	Command.withShortDescription("Let the human edit a text."),
	Command.withDescription(
		`Open a text in an editor for the human to change, and return the result.
Cmd/Ctrl+Enter submits. The file named by --text is not modified.

payload: {"text": "..."} — the whole text as they left it.

${ANSWER_NOTE}`,
	),
	Command.withExamples([
		{
			command: "infer human edit --text draft.md --prompt 'Tighten this intro'",
			description: "Have a draft edited",
		},
	]),
);

const formCmd = Command.make(
	"form",
	{
		fields: Flag.String("fields").pipe(
			Flag.withMetavar("json|path"),
			Flag.withDescription(
				`The form: a JSON array of fields, inline or as a path. Each is {"name", "label"?, "type"?, "options"?, "required"?, "placeholder"?, "default"?}; type is one of ${FIELD_TYPES.join(", ")} and defaults to text; a select needs options.`,
			),
		),
		prompt: promptFlag,
		...servingFlags,
	},
	(flags) =>
		Effect.gen(function* () {
			const fields = parseFormFields(yield* loadJson(flags.fields, "--fields"));
			if (typeof fields === "string") {
				return yield* Effect.fail(new UiError({ reason: fields }));
			}
			yield* runPreset(
				{ kind: "form", prompt: Option.getOrUndefined(flags.prompt), fields },
				flags,
			);
		}),
).pipe(
	Command.withShortDescription("Ask the human to fill in a short form."),
	Command.withDescription(
		`Ask the human to fill in a short form. Required fields must be filled
before it can be submitted.

payload: {"values": {"<name>": <value>, ...}} — strings, numbers for number
fields, booleans for checkboxes.

${ANSWER_NOTE}`,
	),
	Command.withExamples([
		{
			command: `infer human form --fields '[{"name":"title","required":true},{"name":"tone","type":"select","options":["formal","casual"]}]'`,
			description: "Collect a few details",
		},
	]),
);

export const humanCmd = Command.make("human").pipe(
	Command.withShortDescription(
		"Ask the human: show them a page and get their answer back.",
	),
	Command.withDescription(
		`Ask the human, through a real web page, and get their answer back.

Every other command answers from a provider; this one answers from the
person at the keyboard. The page is a .tsx file opened in their browser,
and the command blocks until they act on it, so the answer is theirs.

For the common shapes no page is needed: pick, approve, rank, edit and
form take only data. For anything else, ask and present serve a .tsx
page you write. The page opens on this computer by default; add --share
to open it on another device, such as a phone.`,
	),
	Command.withSubcommands([
		pickCmd,
		approveCmd,
		rankCmd,
		editCmd,
		formCmd,
		askCmd,
		presentCmd,
	]),
);
