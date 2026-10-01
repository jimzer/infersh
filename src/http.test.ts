import { afterAll, describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { HttpClient } from "effect/http";
import { layerWithTimeout, REQUEST_TIMEOUT } from "./http.ts";

describe("the shared HTTP client", () => {
	// Answers /fast at once and never answers /hang.
	const server = Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === "/fast"
				? new Response("ok")
				: new Promise<Response>(() => {}),
	});
	afterAll(() => server.stop(true));

	const get = (path: string) =>
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient;
			const response = yield* http.get(`${server.url}${path.slice(1)}`);
			return yield* response.text;
		}).pipe(
			Effect.provide(layerWithTimeout(Duration.millis(200))),
			Effect.result,
			Effect.runPromise,
		);

	test("gives up on a request that never answers, as a transport error", async () => {
		const result = await get("/hang");
		expect(result._tag).toBe("Failure");
		expect(String(result._tag === "Failure" && result.failure)).toContain(
			"no response after",
		);
	});

	test("leaves a request that answers alone", async () => {
		const result = await get("/fast");
		expect(result._tag === "Success" && result.success).toBe("ok");
	});

	test("defaults to a timeout too long to matter in normal use", () => {
		expect(Duration.toMinutes(REQUEST_TIMEOUT)).toBeGreaterThanOrEqual(10);
	});
});
