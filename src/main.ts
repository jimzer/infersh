#!/usr/bin/env bun

import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { runUpdateCheck } from "./autoupdate.ts";
import * as Bdata from "./bdata.ts";
import { bdataCmd } from "./commands/bdata.ts";
import { falCmd } from "./commands/fal.ts";
import { groqCmd } from "./commands/groq.ts";
import { keysCmd } from "./commands/keys.ts";
import { renderCmd } from "./commands/render.ts";
import { updateCmd } from "./commands/update.ts";
import * as Fal from "./fal.ts";
import * as Groq from "./groq.ts";
import * as Render from "./render.ts";
import * as Secrets from "./secrets.ts";
import { VERSION } from "./version.ts";

// Secrets and the HTTP client are needed both directly by commands and by the
// fal layer, so they are merged in rather than only provided underneath it.
const base = Layer.mergeAll(
	Secrets.layer,
	FetchHttpClient.layer,
	BunServices.layer,
);

const appLayer = Layer.mergeAll(
	base,
	Fal.layer.pipe(Layer.provide(base)),
	Groq.layer.pipe(Layer.provide(base)),
	Bdata.layer.pipe(Layer.provide(base)),
	Render.layer,
);

const inferCmd = Command.make("infer").pipe(
	Command.withDescription("Run inference providers from the command line."),
	Command.withSubcommands([
		bdataCmd,
		falCmd,
		groqCmd,
		keysCmd,
		renderCmd,
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
	Effect.provide(appLayer),
	Effect.runPromise,
);

// After the command, never before: this way the check cannot delay output,
// and an auto-install cannot swap the binary while it is still running.
await runUpdateCheck();

process.exit(exitCode);
