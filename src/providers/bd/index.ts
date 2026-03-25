/**
 * Brightdata provider — composed Effect CLI command tree.
 */

import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { BdLive } from "./client.ts";
import { googleCmd } from "./google.ts";
import { instagramCmd } from "./instagram.ts";
import { linkedinCmd } from "./linkedin.ts";
import { pinterestCmd } from "./pinterest.ts";
import { scrapeCmd } from "./scrape.ts";
import { searchCmd } from "./search.ts";
import { tiktokCmd } from "./tiktok.ts";
import { youtubeCmd } from "./youtube.ts";

const balanceCmd = Command.make("balance", {}, () =>
	Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: () =>
				fetch("https://api.brightdata.com/customer/balance", {
					headers: {
						Authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
					},
				}),
			catch: (e) => new Error(`${e}`),
		});
		const text = yield* Effect.tryPromise({
			try: () => res.text(),
			catch: (e) => new Error(`${e}`),
		});
		if (!res.ok) {
			yield* Console.error(`API error ${res.status}: ${text}`);
			return;
		}
		try {
			const data = JSON.parse(text) as {
				balance: number;
				pending_balance: number;
			};
			yield* Console.log(`Balance:         $${data.balance.toFixed(2)}`);
			yield* Console.log(
				`Pending balance: $${data.pending_balance.toFixed(2)}`,
			);
		} catch {
			yield* Console.log(text);
		}
	}),
);

const bdCmd = Command.make("bd").pipe(
	Command.withSubcommands([
		balanceCmd,
		searchCmd,
		scrapeCmd,
		linkedinCmd,
		googleCmd,
		instagramCmd,
		tiktokCmd,
		youtubeCmd,
		pinterestCmd,
	]),
);

export async function run(args: string[]): Promise<void> {
	const { BunServices } = await import("@effect/platform-bun");
	await (
		Command.runWith(bdCmd, { version: "0.1.0" })(args) as Effect.Effect<void>
	).pipe(
		Effect.provide(BdLive),
		Effect.provide(BunServices.layer),
		Effect.runPromise,
	);
}
