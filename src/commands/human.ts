/**
 * `infer human` — ask the human: show them a page and wait for what they do.
 */

import { resolve } from "node:path";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { JsonText } from "../json.ts";
import { emitJson, jsonFlag } from "../output.ts";
import { Ui, UiError, type UiRequest, type UiResult } from "../ui.ts";

const APP_NOTE =
	"Path to a .tsx file that renders the page into #root. Relative imports of other files are inlined automatically; package imports such as react are installed on demand, so nothing has to be set up first.";

/** Accepts inline JSON or a path to a JSON file, the same way `render --props` does. */
const resolveData = (
	data: Option.Option<string>,
): Effect.Effect<unknown, UiError> =>
	Effect.gen(function* () {
		if (Option.isNone(data)) return undefined;
		const trimmed = data.value.trimStart();
		const raw =
			trimmed.startsWith("{") || trimmed.startsWith("[")
				? data.value
				: yield* Effect.tryPromise({
						try: async () => {
							const file = Bun.file(resolve(data.value));
							if (!(await file.exists())) {
								throw new Error(`file not found: ${data.value}`);
							}
							return file.text();
						},
						catch: (cause) =>
							new UiError({ reason: `Could not read --data: ${cause}` }),
					});
		return yield* Schema.decodeUnknownEffect(JsonText)(raw).pipe(
			Effect.mapError(
				() => new UiError({ reason: "--data is not valid JSON." }),
			),
		);
	});

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
			appPath: app,
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
	Command.withDescription(
		"Show the user a page and wait until they have read it. A Done button is added automatically, so the page needs no submit logic at all. Blocks until they click it, which makes it a review gate rather than a notification.",
	),
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

ask waits for them to submit something; present waits until they have
read the page. The page opens on this computer by default; add --share
to open it on another device, such as a phone.`,
	),
	Command.withSubcommands([askCmd, presentCmd]),
);
