#!/usr/bin/env bun

import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { updateCheck } from "./autoupdate.ts";
import * as Bdata from "./bdata.ts";
import * as Budget from "./budget.ts";
import { bdataCmd } from "./commands/bdata.ts";
import { budgetCmd } from "./commands/budget.ts";
import { eachCmd } from "./commands/each.ts";
import { falCmd } from "./commands/fal.ts";
import { groqCmd } from "./commands/groq.ts";
import { humanCmd } from "./commands/human.ts";
import { keysCmd } from "./commands/keys.ts";
import { mediaCmd } from "./commands/media.ts";
import { openrouterCmd } from "./commands/openrouter.ts";
import { renderCmd } from "./commands/render.ts";
import { shotCmd } from "./commands/shot.ts";
import { skillsCmd } from "./commands/skills.ts";
import { updateCmd } from "./commands/update.ts";
import * as Fal from "./fal.ts";
import * as Groq from "./groq.ts";
import * as Http from "./http.ts";
import * as OpenRouter from "./openrouter.ts";
import { plainConsole } from "./output.ts";
import * as Render from "./render.ts";
import * as Secrets from "./secrets.ts";
import * as Skills from "./skills.ts";
import * as Ui from "./ui.ts";
import { BUILD_BUN_VERSION, bunUpgradeNotice, VERSION } from "./version.ts";

// Printed before anything runs, so it precedes the TypeError it would explain
// rather than trailing after it.
const bunNotice = bunUpgradeNotice(Bun.version, BUILD_BUN_VERSION);
if (bunNotice !== null) process.stderr.write(`${bunNotice}\n\n`);

// Secrets and the HTTP client are needed both directly by commands and by the
// fal layer, so they are merged in rather than only provided underneath it.
const base = Layer.mergeAll(Secrets.layer, Http.layer, BunServices.layer);

const appLayer = Layer.mergeAll(
	base,
	Fal.layer.pipe(Layer.provide(base)),
	Groq.layer.pipe(Layer.provide(base)),
	Bdata.layer.pipe(Layer.provide(base)),
	Budget.layer.pipe(Layer.provide(base)),
	OpenRouter.layer.pipe(Layer.provide(base)),
	Render.layer.pipe(Layer.provide(base)),
	Skills.layer,
	Ui.layer.pipe(Layer.provide(base)),
);

const inferCmd = Command.make("infer").pipe(
	Command.withDescription("Run inference providers from the command line."),
	Command.withSubcommands([
		bdataCmd,
		budgetCmd,
		eachCmd,
		falCmd,
		groqCmd,
		humanCmd,
		keysCmd,
		mediaCmd,
		openrouterCmd,
		renderCmd,
		shotCmd,
		skillsCmd,
		updateCmd,
	]),
);

// `runWith` already absorbs the QuitError raised when a prompt is cancelled,
// so everything left here is a real failure worth printing. The exit code is
// carried out rather than thrown so the update check still runs.
const exitCode = await Command.runWith(inferCmd, { version: VERSION })(
	process.argv.slice(2),
).pipe(
	Effect.as(0),
	Effect.catch((error) => Console.error(error.message).pipe(Effect.as(1))),
	// After the command, never before: this way the check cannot delay output,
	// and an auto-install cannot swap the binary while it is still running.
	Effect.tap(() => updateCheck),
	Effect.provide(appLayer),
	Effect.provideService(Console.Console, plainConsole),
	Effect.runPromise,
);

process.exit(exitCode);
