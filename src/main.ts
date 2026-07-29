#!/usr/bin/env bun

import { BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { runUpdateCheck } from "./autoupdate.ts";
import { keysCmd } from "./commands/keys.ts";
import { updateCmd } from "./commands/update.ts";
import * as Secrets from "./secrets.ts";
import { VERSION } from "./version.ts";

const inferCmd = Command.make("infer").pipe(
	Command.withDescription("Run inference providers from the command line."),
	Command.withSubcommands([keysCmd, updateCmd]),
);

// `runWith` already absorbs the QuitError raised when a prompt is cancelled,
// so everything left here is a real failure worth printing. The exit code is
// carried out rather than thrown so the update check still runs.
const exitCode = await Command.runWith(inferCmd, { version: VERSION })(
	process.argv.slice(2),
).pipe(
	Effect.as(0),
	Effect.catch((error) => Console.error(error.message).pipe(Effect.as(1))),
	Effect.provide(Secrets.layer),
	Effect.provide(BunServices.layer),
	Effect.runPromise,
);

// After the command, never before: this way the check cannot delay output,
// and an auto-install cannot swap the binary while it is still running.
await runUpdateCheck();

process.exit(exitCode);
