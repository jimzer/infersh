/**
 * `Budget` — how much money is left with each provider.
 *
 * What each provider actually exposes differs, and only two of the three
 * expose anything at all:
 *
 * - **fal.ai** — `GET /v1/account/billing?expand=credits` returns a credit
 *   balance, but only to an *Admin*-scope key. An API-scope key gets 403.
 * - **Bright Data** — `GET /customer/balance` returns the balance plus the
 *   spend not yet deducted, to an ordinary API key.
 * - **Groq** — nothing. Spend is visible in the console only, so the report
 *   says so rather than guessing. Groq's rate-limit response headers describe
 *   the current window's quota, not money, and reading them would mean issuing
 *   a billed inference call from a command whose job is to watch spending.
 *
 * A report never fails. One unreachable provider must not hide the others, so
 * every outcome — no key, wrong key scope, HTTP error, no API at all — comes
 * back as data. See `docs/adrs/0014`.
 */

import { Context, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient } from "effect/unstable/http";
import {
	type ProviderId,
	providerIds,
	providers,
	Secrets,
	type SecretsShape,
} from "./secrets.ts";

/** `expand=credits` is required — without it the response is only a username. */
const FAL_BILLING_URL = "https://api.fal.ai/v1/account/billing?expand=credits";

/** Bright Data's Account Management API. */
const BRIGHTDATA_BALANCE_URL = "https://api.brightdata.com/customer/balance";

/** The only place Groq exposes spend. */
export const GROQ_BILLING_CONSOLE = "https://console.groq.com/settings/billing";

/** OpenRouter reports credits granted and used, not a balance directly. */
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

export interface Balance {
	/** Money left to spend, in {@link Balance.currency}. */
	readonly available: number;
	readonly currency: string;
	/** Spend already incurred but not yet deducted, where reported. */
	readonly pending?: number;
	/** Provider-specific extras, such as Bright Data's promotional credit. */
	readonly detail?: Readonly<Record<string, number>>;
}

/**
 * One provider's outcome.
 *
 * Deliberately a union rather than `Balance | null`: "no key set", "wrong key
 * scope" and "this provider has no such API" each need a different thing done
 * about them, and collapsing them would lose that.
 */
export type Report =
	| {
			readonly _tag: "Balance";
			readonly provider: ProviderId;
			readonly balance: Balance;
	  }
	| { readonly _tag: "NoKey"; readonly provider: ProviderId }
	| {
			readonly _tag: "NoApi";
			readonly provider: ProviderId;
			readonly reason: string;
			readonly console: string;
	  }
	| {
			readonly _tag: "Denied";
			readonly provider: ProviderId;
			readonly reason: string;
	  }
	| {
			readonly _tag: "Failed";
			readonly provider: ProviderId;
			readonly reason: string;
	  };

// --- Parsing --------------------------------------------------------------

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** `{ username, credits: { current_balance, currency } }` → a balance. */
export const parseFalBilling = (payload: unknown): Balance | null => {
	if (typeof payload !== "object" || payload === null) return null;
	const credits = (payload as { credits?: unknown }).credits;
	// Absent whenever expand=credits was not sent, or the account has no
	// credit balance at all — neither is an error, but neither is a number.
	if (typeof credits !== "object" || credits === null) return null;
	const available = asNumber(
		(credits as { current_balance?: unknown }).current_balance,
	);
	if (available === undefined) return null;
	const currency = (credits as { currency?: unknown }).currency;
	return {
		available,
		currency: typeof currency === "string" ? currency : "USD",
	};
};

/** `{ balance, credit, prepayment, pending_costs }` → a balance. */
export const parseBrightDataBalance = (payload: unknown): Balance | null => {
	if (typeof payload !== "object" || payload === null) return null;
	const raw = payload as Record<string, unknown>;
	const available = asNumber(raw.balance);
	if (available === undefined) return null;

	// The live response calls it pending_costs; the docs say pending_balance.
	const pending = asNumber(raw.pending_costs) ?? asNumber(raw.pending_balance);

	const detail: Record<string, number> = {};
	for (const field of ["credit", "prepayment"] as const) {
		const value = asNumber(raw[field]);
		if (value !== undefined) detail[field] = value;
	}

	return {
		available,
		// This endpoint reports no currency at all; Bright Data accounts are USD.
		currency: "USD",
		...(pending === undefined ? {} : { pending }),
		...(Object.keys(detail).length === 0 ? {} : { detail }),
	};
};

/**
 * `{ data: { total_credits, total_usage } }` → a balance.
 *
 * OpenRouter reports the two totals rather than what is left, so the balance
 * is derived. Both must be present: subtracting a missing `total_usage` from
 * credits would report the full purchase as still available.
 */
export const parseOpenRouterCredits = (payload: unknown): Balance | null => {
	if (typeof payload !== "object" || payload === null) return null;
	const data = (payload as { data?: unknown }).data;
	const source = (
		typeof data === "object" && data !== null ? data : payload
	) as Record<string, unknown>;
	const granted = asNumber(source.total_credits);
	const used = asNumber(source.total_usage);
	if (granted === undefined || used === undefined) return null;
	return {
		available: granted - used,
		currency: "USD",
		detail: { granted, used },
	};
};

// --- Rendering ------------------------------------------------------------

/** `5.42` in USD → `$5.42`, falling back to `5.42 XYZ` for unknown codes. */
export const formatMoney = (amount: number, currency: string): string => {
	try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
		}).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
};

/** The human-readable half of one report line. */
export const describeReport = (report: Report): string => {
	switch (report._tag) {
		case "Balance": {
			const { available, currency, pending } = report.balance;
			const line = `${formatMoney(available, currency)} available`;
			// Zero pending is the normal case and adds nothing worth a column.
			return pending
				? `${line}   ${formatMoney(pending, currency)} pending`
				: line;
		}
		case "NoKey": {
			const info = providers[report.provider];
			return `no key set — run \`infer keys set\` or set ${info.env}`;
		}
		case "NoApi":
			return `${report.reason} — see ${report.console}`;
		case "Denied":
		case "Failed":
			return report.reason;
	}
};

/** Stable status word for `--json`, so a caller can branch without prose. */
export const statusOf = (report: Report): string =>
	report._tag === "Balance"
		? "ok"
		: report._tag === "NoKey"
			? "no-key"
			: report._tag === "NoApi"
				? "no-api"
				: report._tag === "Denied"
					? "denied"
					: "error";

/** One report as a flat JSON object: never nested, never absent keys mid-list. */
export const reportJson = (report: Report): Record<string, unknown> => {
	const base = { provider: report.provider, status: statusOf(report) };
	switch (report._tag) {
		case "Balance":
			return {
				...base,
				available: report.balance.available,
				currency: report.balance.currency,
				...(report.balance.pending === undefined
					? {}
					: { pending: report.balance.pending }),
				...(report.balance.detail === undefined
					? {}
					: { detail: report.balance.detail }),
			};
		case "NoKey":
			return { ...base, message: describeReport(report) };
		case "NoApi":
			return { ...base, message: report.reason, console: report.console };
		case "Denied":
		case "Failed":
			return { ...base, message: report.reason };
	}
};

/** Sums the balances that were actually reported, per currency. */
export const totals = (
	reports: ReadonlyArray<Report>,
): ReadonlyArray<{ readonly currency: string; readonly available: number }> => {
	const sums = new Map<string, number>();
	for (const report of reports) {
		if (report._tag !== "Balance") continue;
		const { currency, available } = report.balance;
		sums.set(currency, (sums.get(currency) ?? 0) + available);
	}
	return [...sums].map(([currency, available]) => ({ currency, available }));
};

// --- Service --------------------------------------------------------------

export interface BudgetShape {
	/** Never fails: an unreachable provider is reported, not raised. */
	readonly check: (provider: ProviderId) => Effect.Effect<Report>;
	readonly checkAll: (
		which?: ReadonlyArray<ProviderId>,
	) => Effect.Effect<ReadonlyArray<Report>>;
}

export class Budget extends Context.Service<Budget, BudgetShape>()("Budget") {}

const make = (options: {
	readonly secrets: SecretsShape;
	readonly http: HttpClient.HttpClient;
}): BudgetShape => {
	const { secrets, http } = options;

	/** GETs a URL and returns the status with the body, without interpreting it. */
	const fetchText = (
		url: string,
		headers: Record<string, string>,
	): Effect.Effect<{ status: number; text: string }, string> =>
		Effect.gen(function* () {
			const response = yield* http
				.get(url, { headers })
				.pipe(Effect.mapError((cause) => `request failed: ${cause}`));
			const text = yield* response.text.pipe(
				Effect.mapError((cause) => `could not read the response: ${cause}`),
			);
			return { status: response.status, text };
		});

	const parseJson = (text: string): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	};

	interface Endpoint {
		readonly provider: ProviderId;
		readonly url: string;
		readonly authorization: (key: string) => string;
		readonly parse: (payload: unknown) => Balance | null;
		/** What a 403 means for this provider, which is never generic. */
		readonly forbidden: string;
	}

	/** One HTTP outcome → one report, so the effect plumbing stays thin. */
	const interpret = (
		endpoint: Endpoint,
		status: number,
		text: string,
	): Report => {
		const { provider } = endpoint;
		if (status === 401) {
			return {
				_tag: "Denied",
				provider,
				reason: "the key was rejected (401) — check it with `infer keys list`",
			};
		}
		if (status === 403) {
			return { _tag: "Denied", provider, reason: endpoint.forbidden };
		}
		if (status >= 400) {
			return {
				_tag: "Failed",
				provider,
				reason: `${providers[provider].label} returned ${status}: ${text.slice(0, 200)}`,
			};
		}
		const balance = endpoint.parse(parseJson(text));
		// A 200 that carries no balance means the response shape changed; saying
		// so with the body attached beats printing a confident zero.
		return balance === null
			? {
					_tag: "Failed",
					provider,
					reason: `could not read a balance from the response: ${text.slice(0, 200)}`,
				}
			: { _tag: "Balance", provider, balance };
	};

	/** Shared shape: resolve a key, call one endpoint, parse one balance. */
	const fromEndpoint = (endpoint: Endpoint): Effect.Effect<Report> =>
		Effect.gen(function* () {
			const { provider } = endpoint;
			const resolved = yield* secrets
				.get(provider)
				.pipe(Effect.orElseSucceed(Option.none));
			if (Option.isNone(resolved)) {
				return { _tag: "NoKey", provider } satisfies Report;
			}

			return yield* fetchText(endpoint.url, {
				Authorization: endpoint.authorization(
					Redacted.value(resolved.value.key),
				),
			}).pipe(
				Effect.map(({ status, text }) => interpret(endpoint, status, text)),
				// The only failures fetchText raises are transport-level, and a
				// provider being unreachable is a reportable state, not a crash.
				Effect.catch((reason) =>
					Effect.succeed<Report>({ _tag: "Failed", provider, reason }),
				),
			);
		});

	const check: BudgetShape["check"] = (provider) => {
		switch (provider) {
			case "fal":
				return fromEndpoint({
					provider,
					url: FAL_BILLING_URL,
					authorization: (key) => `Key ${key}`,
					parse: parseFalBilling,
					forbidden:
						"needs an Admin-scope key (this one is API scope) — create one at https://fal.ai/dashboard/keys",
				});
			case "brightdata":
				return fromEndpoint({
					provider,
					url: BRIGHTDATA_BALANCE_URL,
					authorization: (key) => `Bearer ${key}`,
					parse: parseBrightDataBalance,
					forbidden:
						"the key is not permitted to read the account balance — it may lack account-management permission",
				});
			case "openrouter":
				return fromEndpoint({
					provider,
					url: OPENROUTER_CREDITS_URL,
					authorization: (key) => `Bearer ${key}`,
					parse: parseOpenRouterCredits,
					forbidden:
						"the key is not permitted to read credits — a provisioning key cannot, an inference key can",
				});
			case "groq":
				return Effect.succeed<Report>({
					_tag: "NoApi",
					provider,
					reason: "no billing API; spend is in the console only",
					console: GROQ_BILLING_CONSOLE,
				});
		}
	};

	return {
		check,
		checkAll: (which) => {
			const list =
				which === undefined || which.length === 0 ? providerIds : which;
			// Concurrent, but Effect.forEach keeps the requested order in the result.
			return Effect.forEach(list, check, { concurrency: list.length });
		},
	};
};

export const layer: Layer.Layer<
	Budget,
	never,
	Secrets | HttpClient.HttpClient
> = Layer.effect(Budget)(
	Effect.gen(function* () {
		const secrets = yield* Secrets;
		const http = yield* HttpClient.HttpClient;
		return make({ secrets, http });
	}),
);
