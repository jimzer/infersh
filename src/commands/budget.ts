/**
 * `infer budget` — remaining balance per provider.
 */

import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import {
	Budget,
	describeReport,
	formatMoney,
	reportJson,
	totals,
} from "../budget.ts";
import { emitJson, jsonFlag } from "../output.ts";
import { providerIds } from "../secrets.ts";

export const budgetCmd = Command.make(
	"budget",
	{
		providers: Argument.choice("provider", providerIds).pipe(
			Argument.atLeast(0),
			Argument.withDescription(
				"Which providers to check. Omit to check every one. Repeat to check several.",
			),
		),
		json: jsonFlag,
	},
	(config) =>
		Effect.gen(function* () {
			const budget = yield* Budget;
			const reports = yield* budget.checkAll(config.providers);

			if (config.json) {
				return yield* emitJson({
					providers: reports.map(reportJson),
					totals: totals(reports),
				});
			}

			for (const report of reports) {
				yield* Console.log(
					`${report.provider.padEnd(12)} ${describeReport(report)}`,
				);
			}

			// Worth a line only when there is actual addition to show: counting
			// reports rather than balances would print a "total" of one number
			// whenever a silent provider padded the list.
			const sums = totals(reports);
			const answered = reports.filter(
				(report) => report._tag === "Balance",
			).length;
			if (answered > 1) {
				const rendered = sums
					.map((sum) => formatMoney(sum.available, sum.currency))
					.join(" + ");
				yield* Console.log(`\ntotal        ${rendered}`);
			}
		}),
).pipe(
	Command.withShortDescription("Show the money left with each provider."),
	Command.withDescription(
		`Report the remaining balance for each provider.

What is available differs by provider, because their APIs do:

  fal.ai       credit balance — requires an Admin-scope key, not the
               API-scope key that running models needs. An API-scope key
               is reported as such rather than failing.
  brightdata   balance, plus the spend not yet deducted from it.
  groq         nothing. Groq exposes spend in its console only, so this
               prints a link. Its rate-limit headers describe the current
               window's quota rather than money, and reading them would
               mean paying for an inference call to ask about billing.

Always exits 0. A provider that cannot report — no key, the wrong key
scope, no such API — is part of the answer, not a failure, so one silent
provider never hides the others. With --json, branch on \`status\`, which is
one of ok, no-key, no-api, denied, error.

Balances are not live to the last cent: providers settle usage on their
own schedules, so treat a figure as recent rather than exact.`,
	),
	Command.withExamples([
		{ command: "infer budget", description: "Check every provider" },
		{
			command: "infer budget fal",
			description: "Check one provider only",
		},
		{
			command: "infer budget --json | jq '.totals'",
			description: "Read the summed balance programmatically",
		},
		{
			command: `infer budget --json | jq -e '.providers[] | select(.provider=="fal") | .available > 1'`,
			description: "Fail a script when fal.ai runs low",
		},
	]),
);
