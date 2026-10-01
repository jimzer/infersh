/**
 * The HTTP client every provider uses: Effect's fetch client with one timeout
 * applied to every request.
 *
 * The timeout is deliberately absurd. It exists so a provider that stops
 * answering cannot hang the CLI forever — not to tune latency, since no
 * provider's real worst case is known yet. When one is, tighten it here for
 * everyone, or with `Effect.timeout` on that one call.
 *
 * It covers requests made through `HttpClient`. The fal client issues its own
 * requests and is not covered.
 */

import { Duration, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";

export const REQUEST_TIMEOUT = Duration.minutes(10);

/** The client with a given timeout; tests use a short one. */
export const layerWithTimeout = (
	timeout: Duration.Duration,
): Layer.Layer<HttpClient.HttpClient> =>
	Layer.effect(HttpClient.HttpClient)(
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			return HttpClient.transform(client, (response, request) =>
				response.pipe(
					Effect.timeoutOrElse({
						duration: timeout,
						orElse: () =>
							Effect.fail(
								new HttpClientError.HttpClientError({
									reason: new HttpClientError.TransportError({
										request,
										description: `no response after ${Duration.format(timeout)}`,
									}),
								}),
							),
					}),
				),
			);
		}),
	).pipe(Layer.provide(FetchHttpClient.layer));

export const layer: Layer.Layer<HttpClient.HttpClient> =
	layerWithTimeout(REQUEST_TIMEOUT);
