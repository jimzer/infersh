#!/usr/bin/env bun

import { BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { keysCmd } from "./commands/keys.ts";

const VERSION = "0.2.0";

const inferCmd = Command.make("infer").pipe(
	Command.withDescription("Run inference providers from the command line."),
	Command.withSubcommands([keysCmd]),
);

// `runWith` already absorbs the QuitError raised when a prompt is cancelled,
// so everything left here is a real failure worth printing.
await Command.runWith(inferCmd, { version: VERSION })(
	process.argv.slice(2),
).pipe(
	Effect.catch((error) =>
		Effect.gen(function* () {
			yield* Console.error(error.message);
			yield* Effect.sync(() => process.exit(1));
		}),
	),
	Effect.provide(BunServices.layer),
	Effect.runPromise,
);
