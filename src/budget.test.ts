import { describe, expect, test } from "bun:test";
import {
	describeReport,
	formatMoney,
	GROQ_BILLING_CONSOLE,
	parseBrightDataBalance,
	parseFalBilling,
	parseOpenRouterCredits,
	type Report,
	reportJson,
	statusOf,
	totals,
} from "./budget.ts";

describe("parseFalBilling", () => {
	test("reads the credit balance from a live-shaped response", () => {
		expect(
			parseFalBilling({
				username: "jimzer",
				credits: { current_balance: 8.35, currency: "USD" },
			}),
		).toEqual({ available: 8.35, currency: "USD" });
	});

	test("returns null when expand=credits was not sent", () => {
		// The endpoint answers 200 with only a username, which is not a balance.
		expect(parseFalBilling({ username: "jimzer" })).toBeNull();
	});

	test("keeps a zero balance, which is a fact rather than a miss", () => {
		expect(
			parseFalBilling({ credits: { current_balance: 0, currency: "USD" } }),
		).toEqual({ available: 0, currency: "USD" });
	});

	test("defaults the currency when the provider omits it", () => {
		expect(parseFalBilling({ credits: { current_balance: 1.5 } })).toEqual({
			available: 1.5,
			currency: "USD",
		});
	});

	test("rejects a non-numeric balance rather than coercing it", () => {
		expect(
			parseFalBilling({ credits: { current_balance: "8.35" } }),
		).toBeNull();
		expect(parseFalBilling({ credits: { current_balance: null } })).toBeNull();
	});

	test("rejects payloads that are not objects", () => {
		for (const payload of [null, "text", 42, []]) {
			expect(parseFalBilling(payload)).toBeNull();
		}
	});
});

describe("parseBrightDataBalance", () => {
	test("reads the live response shape", () => {
		expect(
			parseBrightDataBalance({
				balance: 5.42,
				credit: 0,
				prepayment: 0,
				pending_costs: 0.02,
			}),
		).toEqual({
			available: 5.42,
			currency: "USD",
			pending: 0.02,
			detail: { credit: 0, prepayment: 0 },
		});
	});

	test("accepts the pending_balance name the docs use", () => {
		const balance = parseBrightDataBalance({
			balance: 10,
			pending_balance: 1.5,
		});
		expect(balance?.pending).toBe(1.5);
	});

	test("prefers pending_costs when both are present", () => {
		const balance = parseBrightDataBalance({
			balance: 10,
			pending_costs: 2,
			pending_balance: 9,
		});
		expect(balance?.pending).toBe(2);
	});

	test("omits pending and detail entirely when absent", () => {
		expect(parseBrightDataBalance({ balance: 3 })).toEqual({
			available: 3,
			currency: "USD",
		});
	});

	test("rejects a response with no balance", () => {
		expect(parseBrightDataBalance({ credit: 5 })).toBeNull();
	});
});

describe("formatMoney", () => {
	test("renders a known currency as a symbol", () => {
		expect(formatMoney(5.42, "USD")).toBe("$5.42");
	});

	test("falls back to a suffixed code for an unknown one", () => {
		// Intl throws on a bad code; a balance is too useful to lose over it.
		expect(formatMoney(5.4, "NOTACURRENCY")).toBe("5.40 NOTACURRENCY");
	});
});

const balance = (available: number, pending?: number): Report => ({
	_tag: "Balance",
	provider: "fal",
	balance: {
		available,
		currency: "USD",
		...(pending === undefined ? {} : { pending }),
	},
});

describe("describeReport", () => {
	test("shows pending only when it is non-zero", () => {
		expect(describeReport(balance(8.35))).toBe("$8.35 available");
		expect(describeReport(balance(8.35, 0))).toBe("$8.35 available");
		expect(describeReport(balance(8.35, 0.02))).toContain("$0.02 pending");
	});

	test("names the env var when no key is set", () => {
		expect(describeReport({ _tag: "NoKey", provider: "groq" })).toContain(
			"GROQ_API_KEY",
		);
	});

	test("points at the console when there is no API", () => {
		expect(
			describeReport({
				_tag: "NoApi",
				provider: "groq",
				reason: "no billing API",
				console: GROQ_BILLING_CONSOLE,
			}),
		).toContain(GROQ_BILLING_CONSOLE);
	});
});

describe("statusOf", () => {
	test("maps every case to a stable word", () => {
		expect(statusOf(balance(1))).toBe("ok");
		expect(statusOf({ _tag: "NoKey", provider: "fal" })).toBe("no-key");
		expect(
			statusOf({ _tag: "NoApi", provider: "groq", reason: "", console: "" }),
		).toBe("no-api");
		expect(statusOf({ _tag: "Denied", provider: "fal", reason: "" })).toBe(
			"denied",
		);
		expect(statusOf({ _tag: "Failed", provider: "fal", reason: "" })).toBe(
			"error",
		);
	});
});

describe("reportJson", () => {
	test("puts the balance at the top level, not nested", () => {
		expect(reportJson(balance(8.35, 0.02))).toEqual({
			provider: "fal",
			status: "ok",
			available: 8.35,
			currency: "USD",
			pending: 0.02,
		});
	});

	test("carries a message for every non-balance case", () => {
		for (const report of [
			{ _tag: "NoKey", provider: "fal" },
			{ _tag: "Denied", provider: "fal", reason: "wrong scope" },
			{ _tag: "Failed", provider: "fal", reason: "boom" },
			{
				_tag: "NoApi",
				provider: "groq",
				reason: "none",
				console: GROQ_BILLING_CONSOLE,
			},
		] satisfies Report[]) {
			expect(reportJson(report).message).toBeString();
		}
	});

	test("every report carries provider and status", () => {
		const json = reportJson({
			_tag: "Failed",
			provider: "brightdata",
			reason: "x",
		});
		expect(json.provider).toBe("brightdata");
		expect(json.status).toBe("error");
	});
});

describe("totals", () => {
	test("sums matching currencies and ignores unreported providers", () => {
		expect(
			totals([
				balance(8.35),
				{ _tag: "NoApi", provider: "groq", reason: "", console: "" },
				{
					_tag: "Balance",
					provider: "brightdata",
					balance: { available: 5.42, currency: "USD" },
				},
			]),
		).toEqual([{ currency: "USD", available: 13.77 }]);
	});

	test("keeps currencies apart rather than adding unlike things", () => {
		expect(
			totals([
				balance(10),
				{
					_tag: "Balance",
					provider: "brightdata",
					balance: { available: 5, currency: "EUR" },
				},
			]),
		).toEqual([
			{ currency: "USD", available: 10 },
			{ currency: "EUR", available: 5 },
		]);
	});

	test("is empty when nothing reported", () => {
		expect(totals([{ _tag: "NoKey", provider: "fal" }])).toEqual([]);
	});
});

describe("parseOpenRouterCredits", () => {
	test("derives the balance from granted minus used", () => {
		expect(
			parseOpenRouterCredits({
				data: { total_credits: 50, total_usage: 12.5 },
			}),
		).toEqual({
			available: 37.5,
			currency: "USD",
			detail: { granted: 50, used: 12.5 },
		});
	});

	test("accepts an unwrapped payload too", () => {
		expect(
			parseOpenRouterCredits({ total_credits: 10, total_usage: 1 })?.available,
		).toBe(9);
	});

	test("refuses to guess when usage is missing", () => {
		// Treating a missing total_usage as zero would report the whole purchase
		// as still available.
		expect(parseOpenRouterCredits({ data: { total_credits: 50 } })).toBeNull();
	});

	test("returns null for an unexpected shape", () => {
		expect(parseOpenRouterCredits({ data: "nope" })).toBeNull();
		expect(parseOpenRouterCredits(null)).toBeNull();
	});
});
