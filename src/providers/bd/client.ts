/**
 * Brightdata provider — Effect service for REST API calls.
 * Replaces @brightdata/sdk with direct HTTP via Effect.
 */

import { Console, Effect, Layer, Schedule, ServiceMap } from "effect";

export class BdError {
	readonly _tag = "BdError";
	constructor(readonly message: string) {}
}

export interface RequestBody {
	url: string;
	zone: "sdk_serp" | "sdk_unlocker";
	format?: "raw" | "json";
	data_format?: "html" | "markdown" | "screenshot";
	country?: string;
}

export interface DatasetOpts {
	format?: string;
	type?: string;
	discover_by?: string;
}

interface BdShape {
	readonly request: (body: RequestBody) => Effect.Effect<string, BdError>;
	readonly collect: (
		datasetId: string,
		input: unknown[],
		opts?: DatasetOpts,
	) => Effect.Effect<unknown, BdError>;
	readonly trigger: (
		datasetId: string,
		input: unknown[],
		opts?: DatasetOpts,
	) => Effect.Effect<unknown, BdError>;
}

export class Bd extends ServiceMap.Service<Bd, BdShape>()("Bd") {}

const API_BASE = "https://api.brightdata.com";

const getApiKey = () => {
	const key = process.env.BRIGHTDATA_API_KEY;
	if (!key) throw new Error("Set BRIGHTDATA_API_KEY environment variable");
	return key;
};

const apiCall = (method: string, url: string, body?: unknown) =>
	Effect.tryPromise({
		try: () =>
			fetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${getApiKey()}`,
					"Content-Type": "application/json",
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			}),
		catch: (e) => new BdError(`API call failed: ${e}`),
	});

const readBody = (res: Response) =>
	Effect.tryPromise({
		try: async () => {
			const text = await res.text();
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		},
		catch: (e) => new BdError(`Failed to read response: ${e}`),
	});

const readText = (res: Response) =>
	Effect.tryPromise({
		try: () => res.text(),
		catch: (e) => new BdError(`Failed to read response: ${e}`),
	});

const progress = (snapshotId: string) =>
	Effect.gen(function* () {
		const res = yield* apiCall(
			"GET",
			`${API_BASE}/datasets/v3/progress/${snapshotId}`,
		);
		if (!res.ok) {
			const text = yield* readText(res);
			return yield* Effect.fail(
				new BdError(`Progress check failed ${res.status}: ${text}`),
			);
		}
		return yield* Effect.tryPromise({
			try: () => res.json() as Promise<{ status: string }>,
			catch: (e) => new BdError(`${e}`),
		});
	});

const download = (snapshotId: string, opts?: DatasetOpts) =>
	Effect.gen(function* () {
		const params = new URLSearchParams();
		if (opts?.format) params.set("format", opts.format);
		const qs = params.toString();
		const url = `${API_BASE}/datasets/v3/snapshot/${snapshotId}${qs ? `?${qs}` : ""}`;
		const res = yield* apiCall("GET", url);
		if (!res.ok) {
			const text = yield* readText(res);
			return yield* Effect.fail(
				new BdError(`Download failed ${res.status}: ${text}`),
			);
		}
		return yield* readBody(res);
	});

const pollAndDownload = (snapshotId: string, opts?: DatasetOpts) =>
	Effect.gen(function* () {
		yield* Console.error(`Polling snapshot ${snapshotId}...`);
		const poll = Effect.gen(function* () {
			const status = yield* progress(snapshotId);
			if (status.status === "ready" || status.status === "failed") {
				return status;
			}
			yield* Console.error(`Status: ${status.status}, waiting...`);
			return yield* Effect.fail("pending" as const);
		});
		const finalStatus = yield* poll.pipe(
			Effect.retry(
				Schedule.spaced("10 seconds").pipe(
					Schedule.compose(Schedule.recurs(60)),
				),
			),
			Effect.mapError(
				(e): BdError =>
					typeof e === "string" ? new BdError("Polling timed out") : e,
			),
		);
		if (finalStatus.status === "failed") {
			return yield* Effect.fail(new BdError("Dataset collection failed"));
		}
		return yield* download(snapshotId, opts);
	});

const request: BdShape["request"] = (body) =>
	Effect.gen(function* () {
		const payload = { format: "raw" as const, ...body };
		const res = yield* apiCall("POST", `${API_BASE}/request`, payload);
		if (!res.ok) {
			const text = yield* readText(res);
			return yield* Effect.fail(
				new BdError(`Request failed ${res.status}: ${text}`),
			);
		}
		return yield* readText(res);
	});

const collect: BdShape["collect"] = (datasetId, input, opts) =>
	Effect.gen(function* () {
		const params = new URLSearchParams({ dataset_id: datasetId });
		if (opts?.format) params.set("format", opts.format);
		if (opts?.type) params.set("type", opts.type);
		if (opts?.discover_by) params.set("discover_by", opts.discover_by);
		const res = yield* apiCall(
			"POST",
			`${API_BASE}/datasets/v3/scrape?${params}`,
			{ input },
		);

		if (res.status === 202) {
			const data = yield* Effect.tryPromise({
				try: () => res.json() as Promise<{ snapshot_id: string }>,
				catch: (e) => new BdError(`${e}`),
			});
			return yield* pollAndDownload(data.snapshot_id, opts);
		}

		if (!res.ok) {
			const text = yield* readText(res);
			return yield* Effect.fail(
				new BdError(`Collect failed ${res.status}: ${text}`),
			);
		}

		return yield* readBody(res);
	});

const triggerFn: BdShape["trigger"] = (datasetId, input, opts) =>
	Effect.gen(function* () {
		const params = new URLSearchParams({ dataset_id: datasetId });
		if (opts?.format) params.set("format", opts.format);
		if (opts?.type) params.set("type", opts.type);
		if (opts?.discover_by) params.set("discover_by", opts.discover_by);
		const res = yield* apiCall(
			"POST",
			`${API_BASE}/datasets/v3/trigger?${params}`,
			{ input },
		);

		if (!res.ok) {
			const text = yield* readText(res);
			return yield* Effect.fail(
				new BdError(`Trigger failed ${res.status}: ${text}`),
			);
		}

		const data = yield* Effect.tryPromise({
			try: () => res.json() as Promise<{ snapshot_id: string }>,
			catch: (e) => new BdError(`${e}`),
		});
		return yield* pollAndDownload(data.snapshot_id, opts);
	});

export const BdLive = Layer.succeed(Bd)({
	request,
	collect,
	trigger: triggerFn,
});

export function printResult(result: unknown): void {
	if (typeof result === "string") {
		console.log(result);
	} else {
		console.log(JSON.stringify(result, null, 2));
	}
}

export function strip(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined),
	);
}
