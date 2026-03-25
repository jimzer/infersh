/**
 * fal.ai provider.
 * Fetches OpenAPI specs from fal, builds dynamic CLI, calls fal API.
 */

import { BunServices } from "@effect/platform-bun";
import { fal } from "@fal-ai/client";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { buildFlags, configToPayload, resolveLocalFiles } from "../cli.ts";
import { extractInputSchema, fetchSpec } from "../openapi.ts";

const FAL_SPEC_BASE = "https://fal.ai/api/openapi/queue/openapi.json";

function specUrl(endpointId: string): string {
	return `${FAL_SPEC_BASE}?endpoint_id=${encodeURIComponent(endpointId)}`;
}

export async function run(endpointId: string, args: string[]): Promise<void> {
	// Raw JSON mode
	if (args[0] === "json") {
		if (args[1] === "--help" || args[1] === "-h" || !args[1]) {
			const spec = await fetchSpec(specUrl(endpointId));
			const schema = extractInputSchema(spec);
			console.log(JSON.stringify(schema, null, 2));
			return;
		}
		const parsed = JSON.parse(args[1]);
		const payload = await resolveLocalFiles(parsed, (blob) =>
			fal.storage.upload(blob),
		);
		const result = await fal.subscribe(endpointId, { input: payload });
		console.log(JSON.stringify(result.data, null, 2));
		return;
	}

	// Dynamic CLI mode: fetch spec -> build flags -> parse args -> call API
	const spec = await fetchSpec(specUrl(endpointId));
	const schema = extractInputSchema(spec);
	const { flags, jsonFields } = buildFlags(schema);

	const cmd = Command.make(endpointId, flags, (config) =>
		Effect.gen(function* () {
			const raw = configToPayload(
				config as Record<string, unknown>,
				jsonFields,
			);
			const payload = yield* Effect.tryPromise({
				try: () => resolveLocalFiles(raw, (blob) => fal.storage.upload(blob)),
				catch: (e) => e as Error,
			});
			const result = yield* Effect.tryPromise({
				try: () =>
					fal.subscribe(endpointId, {
						input: payload,
						logs: true,
						onQueueUpdate: (update) => {
							if (update.status === "IN_PROGRESS") {
								for (const log of update.logs ?? []) {
									process.stderr.write(`${log.message}\n`);
								}
							}
						},
					}),
				catch: (e) => e as Error,
			});
			yield* Console.log(JSON.stringify(result.data, null, 2));
		}),
	);

	const program = Command.runWith(cmd, { version: "0.1.0" });
	await program(args).pipe(
		Effect.provide(BunServices.layer),
		Effect.runPromise,
	);
}
