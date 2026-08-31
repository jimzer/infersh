import { describe, expect, test } from "bun:test";
import {
	buildSerpUrl,
	chatgptInput,
	datasetScrapeQuery,
	discoverInput,
	linkedinJobsInput,
	linkedinPostsInput,
	linkedinUrlKind,
	mergeOptions,
	parseBody,
	parseInput,
	parseJsonLines,
	REDDIT_SORTS,
	redditCommentsInput,
	redditKeywordInput,
	redditSubredditInput,
	renderResult,
	requestBody,
	resolveDataset,
	snapshotListQuery,
	urlInput,
	videoInput,
	xProfileInput,
} from "./bdata.ts";

const ALLOWED = ["country", "dataFormat", "format", "numResults"] as const;

interface Flags {
	country?: string;
	format?: string;
	start?: number;
}

describe("parseInput", () => {
	test("accepts a JSON object of known options", () => {
		expect(
			parseInput('{"dataFormat":"markdown","country":"gb"}', ALLOWED),
		).toEqual({ options: { dataFormat: "markdown", country: "gb" } });
	});

	test("accepts an empty object", () => {
		expect(parseInput("{}", ALLOWED)).toEqual({ options: {} });
	});

	test("rejects invalid JSON with the parser's reason", () => {
		const result = parseInput("not json", ALLOWED);
		expect("error" in result && result.error).toContain("not valid JSON");
	});

	test("rejects a non-object payload", () => {
		for (const raw of ["[]", '"text"', "42", "null"]) {
			const result = parseInput(raw, ALLOWED);
			expect("error" in result && result.error).toContain("JSON object");
		}
	});

	test("rejects unknown keys instead of silently dropping them", () => {
		// The SDK's schema would ignore data_format; catching it here is the
		// whole reason --input validates rather than passing straight through.
		const result = parseInput('{"data_format":"markdown"}', ALLOWED);
		expect("error" in result && result.error).toContain("data_format");
		expect("error" in result && result.error).toContain("Accepted:");
	});

	test("lists every unknown key", () => {
		const result = parseInput('{"a":1,"b":2}', ALLOWED);
		expect("error" in result && result.error).toContain("a, b");
		expect("error" in result && result.error).toContain("options:");
	});
});

describe("mergeOptions", () => {
	const flags = (over: Flags = {}): Flags => ({
		country: undefined,
		format: undefined,
		start: undefined,
		...over,
	});

	test("keeps input keys the flags do not set", () => {
		expect(mergeOptions({ country: "gb" }, flags())).toEqual({ country: "gb" });
	});

	test("an explicit flag wins over the same key in --input", () => {
		expect(mergeOptions({ country: "gb" }, flags({ country: "us" }))).toEqual({
			country: "us",
		});
	});

	test("drops undefined flags so they never mask an input value", () => {
		const merged = mergeOptions({ format: "json" }, flags());
		expect(merged).toEqual({ format: "json" });
	});

	test("keeps falsy but meaningful flag values", () => {
		expect(mergeOptions({ start: 5 }, flags({ start: 0 }))).toEqual({
			start: 0,
		});
	});
});

describe("renderResult", () => {
	test("prints a raw string unchanged, so HTML stays HTML", () => {
		expect(renderResult("<html>hi</html>")).toBe("<html>hi</html>");
	});

	test("pretty-prints an object so it can be piped to jq", () => {
		expect(renderResult({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	test("handles an array of batch results", () => {
		expect(renderResult([{ a: 1 }])).toContain('"a": 1');
	});
});

describe("buildSerpUrl", () => {
	test("asks Google for parsed JSON via brd_json", () => {
		const url = buildSerpUrl("google", "pizza restaurants", {});
		expect(url).toContain(
			"https://www.google.com/search?q=pizza%20restaurants",
		);
		expect(url).toContain("brd_json=1");
		expect(url).toContain("hl=en");
	});

	test("adds Google paging and geo only when asked", () => {
		const url = buildSerpUrl("google", "pizza", { start: 20, country: "gb" });
		expect(url).toContain("start=20");
		expect(url).toContain("gl=gb");
		expect(buildSerpUrl("google", "pizza", {})).not.toContain("start=");
	});

	test("builds a Bing URL with the market only when a country is given", () => {
		expect(buildSerpUrl("bing", "pizza", { numResults: 25 })).toBe(
			"https://www.bing.com/search?q=pizza&count=25",
		);
		expect(buildSerpUrl("bing", "pizza", { country: "gb" })).toContain(
			"mkt=en_GB",
		);
	});

	test("builds a Yandex URL", () => {
		expect(buildSerpUrl("yandex", "pizza", {})).toBe(
			"https://yandex.com/search/?text=pizza&numdoc=10",
		);
	});

	test("encodes and trims the query", () => {
		expect(buildSerpUrl("google", "  a & b  ", {})).toContain("q=a%20%26%20b&");
	});
});

describe("requestBody", () => {
	test("defaults format to raw and keeps the target url", () => {
		expect(requestBody("https://x.com", "sdk_unlocker", {}, "GET")).toEqual({
			url: "https://x.com",
			zone: "sdk_unlocker",
			method: "GET",
			format: "raw",
		});
	});

	test("omits data_format for the default html", () => {
		const body = requestBody(
			"https://x.com",
			"z",
			{ dataFormat: "html" },
			"GET",
		);
		expect(Object.hasOwn(body, "data_format")).toBe(false);
	});

	test("sends data_format when it is not html", () => {
		expect(
			requestBody("https://x.com", "z", { dataFormat: "markdown" }, "GET"),
		).toMatchObject({ data_format: "markdown" });
	});

	test("expands the md alias the API does not accept", () => {
		expect(
			requestBody("https://x.com", "z", { dataFormat: "md" }, "GET"),
		).toMatchObject({ data_format: "markdown" });
	});

	test("omits country when unset rather than sending undefined", () => {
		const body = requestBody("https://x.com", "z", {}, "GET");
		expect(Object.hasOwn(body, "country")).toBe(false);
	});
});

describe("parseBody", () => {
	test("parses a JSON object or array", () => {
		expect(parseBody('{"a":1}')).toEqual({ a: 1 });
		expect(parseBody("[1,2]")).toEqual([1, 2]);
	});

	test("leaves HTML as a string", () => {
		expect(parseBody("<html><body>hi</body></html>")).toBe(
			"<html><body>hi</body></html>",
		);
	});

	test("leaves malformed JSON as text rather than throwing", () => {
		expect(parseBody('{"a":')).toBe('{"a":');
	});
});

describe("datasetScrapeQuery", () => {
	test("always sends the dataset and include_errors", () => {
		expect(datasetScrapeQuery({ datasetId: "gd_x" })).toBe(
			"dataset_id=gd_x&include_errors=true",
		);
	});

	test("adds the discovery params only when discovering", () => {
		const query = datasetScrapeQuery({
			datasetId: "gd_x",
			type: "discover_new",
			discoverBy: "keyword",
			limitPerInput: 20,
		});
		expect(query).toContain("type=discover_new");
		expect(query).toContain("discover_by=keyword");
		expect(query).toContain("limit_per_input=20");
	});

	test("include_errors can be turned off explicitly", () => {
		expect(
			datasetScrapeQuery({ datasetId: "gd_x", includeErrors: false }),
		).toBe("dataset_id=gd_x&include_errors=false");
	});
});

describe("videoInput", () => {
	test("wraps each url in its own row", () => {
		expect(videoInput(["https://a", "https://b"], {})).toEqual([
			{ url: "https://a" },
			{ url: "https://b" },
		]);
	});

	test("adds optional fields under the API's snake_case names", () => {
		expect(
			videoInput(["https://a"], {
				country: "us",
				transcriptionLanguage: "English",
			}),
		).toEqual([
			{ url: "https://a", country: "us", transcription_language: "English" },
		]);
	});
});

describe("discoverInput", () => {
	test("wraps each keyword in its own row, always with a limit", () => {
		expect(discoverInput(["pizza", "sushi"], { numOfPosts: 5 })).toEqual([
			{ keyword: "pizza", num_of_posts: 5 },
			{ keyword: "sushi", num_of_posts: 5 },
		]);
	});

	test("maps options to the API's field names", () => {
		expect(
			discoverInput(["pizza"], {
				numOfPosts: 20,
				startDate: "2026-01-01",
				endDate: "2026-02-01",
				country: "gb",
			}),
		).toEqual([
			{
				keyword: "pizza",
				num_of_posts: 20,
				start_date: "2026-01-01",
				end_date: "2026-02-01",
				country: "gb",
			},
		]);
	});

	test("never omits num_of_posts, since missing would mean no limit", () => {
		// The API bills per collected video, so an unbounded discovery run is a
		// runaway cost. numOfPosts is required by the type; this pins the
		// behaviour that it always reaches the wire.
		for (const limit of [1, 20, 500]) {
			const [row] = discoverInput(["pizza"], { numOfPosts: limit });
			expect(row).toMatchObject({ num_of_posts: limit });
		}
	});
});

describe("parseJsonLines", () => {
	test("turns an inline multi-row answer into one array", () => {
		const rows = parseJsonLines('{"a":1}\n{"a":2}\n{"a":3}');
		expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
	});

	test("ignores blank lines and a trailing newline", () => {
		expect(parseJsonLines('{"a":1}\n\n{"a":2}\n')).toEqual([
			{ a: 1 },
			{ a: 2 },
		]);
	});

	test("declines a single line, which JSON.parse already handles", () => {
		expect(parseJsonLines('{"a":1}')).toBeNull();
	});

	test("declines anything with a line that is not JSON", () => {
		expect(parseJsonLines('{"a":1}\nnot json')).toBeNull();
	});
});

describe("parseBody with JSON Lines", () => {
	// A dataset job answered inline returns one object per line, which is not a
	// JSON document. Without this, stdout stopped being a single JSON value.
	test("parses a multi-row inline answer into an array", () => {
		const parsed = parseBody('{"post_id":"a"}\n{"post_id":"b"}');
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toEqual([{ post_id: "a" }, { post_id: "b" }]);
	});

	test("still returns a plain object for a single row", () => {
		expect(parseBody('{"post_id":"a"}')).toEqual({ post_id: "a" });
	});

	test("leaves a scraped HTML page as text", () => {
		const html = "<!doctype html>\n<html></html>";
		expect(parseBody(html)).toBe(html);
	});

	test("leaves JSON-looking text that is not JSON alone", () => {
		expect(parseBody("{ not json at all")).toBe("{ not json at all");
	});
});

describe("urlInput", () => {
	test("makes one row per URL", () => {
		expect(
			urlInput(["https://x.com/a/status/1", "https://x.com/b/status/2"]),
		).toEqual([
			{ url: "https://x.com/a/status/1" },
			{ url: "https://x.com/b/status/2" },
		]);
	});
});

describe("xProfileInput", () => {
	test("makes one row per profile, so the limit applies to each", () => {
		expect(xProfileInput(["https://x.com/a", "https://x.com/b"], {})).toEqual([
			{ url: "https://x.com/a" },
			{ url: "https://x.com/b" },
		]);
	});

	test("carries a date window when one is given", () => {
		expect(
			xProfileInput(["https://x.com/a"], {
				startDate: "2026-08-01",
				endDate: "2026-08-07",
			}),
		).toEqual([
			{
				url: "https://x.com/a",
				start_date: "2026-08-01",
				end_date: "2026-08-07",
			},
		]);
	});
});

describe("redditCommentsInput", () => {
	test("sends only the URL when nothing narrows it", () => {
		expect(
			redditCommentsInput(["https://reddit.com/r/a/comments/b/c/"], {}),
		).toEqual([{ url: "https://reddit.com/r/a/comments/b/c/" }]);
	});

	test("carries days_back and sort_by when given", () => {
		expect(
			redditCommentsInput(["https://reddit.com/r/a/comments/b/c/"], {
				daysBack: 30,
				sortBy: "Top",
			}),
		).toEqual([
			{
				url: "https://reddit.com/r/a/comments/b/c/",
				days_back: 30,
				sort_by: "Top",
			},
		]);
	});

	test("keeps days_back of 0, which is a real value rather than absence", () => {
		const [row] = redditCommentsInput(["https://reddit.com/x"], {
			daysBack: 0,
		});
		expect(row).toMatchObject({ days_back: 0 });
	});
});

describe("redditKeywordInput", () => {
	test("always sends num_of_posts, since absent means unlimited", () => {
		for (const limit of [1, 20, 500]) {
			const [row] = redditKeywordInput(["effect"], { numOfPosts: limit });
			expect(row).toMatchObject({ keyword: "effect", num_of_posts: limit });
		}
	});

	test("omits date entirely rather than sending it blank, which is rejected", () => {
		const [row] = redditKeywordInput(["effect"], { numOfPosts: 5 });
		expect(row).not.toHaveProperty("date");
	});

	test("passes a date window through exactly as spelled", () => {
		const [row] = redditKeywordInput(["effect"], {
			numOfPosts: 5,
			date: "Past week",
		});
		expect(row).toMatchObject({ date: "Past week" });
	});
});

describe("redditSubredditInput", () => {
	test("makes one row per subreddit", () => {
		expect(
			redditSubredditInput(
				["https://reddit.com/r/a/", "https://reddit.com/r/b/"],
				{},
			),
		).toHaveLength(2);
	});

	test("carries the sort when given", () => {
		const [row] = redditSubredditInput(["https://reddit.com/r/a/"], {
			sortBy: "Hot",
		});
		expect(row).toMatchObject({ sort_by: "Hot" });
	});
});

describe("REDDIT_SORTS", () => {
	// The published docs list `new`, `top`, `hot`; the API rejects all three
	// with "This value is not allowed". These are what it actually accepts.
	test("is capitalised and includes Rising", () => {
		expect(REDDIT_SORTS).toEqual(["Hot", "New", "Top", "Rising"]);
	});
});

describe("linkedinUrlKind", () => {
	test("routes company, school and showcase pages the same way", () => {
		expect(
			linkedinUrlKind("https://www.linkedin.com/company/bright-data"),
		).toBe("company");
		expect(linkedinUrlKind("https://linkedin.com/school/mit/")).toBe("company");
		expect(linkedinUrlKind("https://www.linkedin.com/showcase/x/")).toBe(
			"company",
		);
	});

	test("routes people pages to the profile discovery route", () => {
		expect(linkedinUrlKind("https://www.linkedin.com/in/someone")).toBe(
			"profile",
		);
		expect(linkedinUrlKind("https://LINKEDIN.com/IN/Someone/")).toBe("profile");
	});

	// Returning null lets the command say which URL is wrong, rather than
	// sending it and getting an empty result back.
	test("returns null for anything that is neither", () => {
		expect(linkedinUrlKind("https://www.linkedin.com/feed/")).toBeNull();
		expect(linkedinUrlKind("https://example.com/company/x")).toBeNull();
	});
});

describe("linkedinPostsInput", () => {
	test("sends only the URL when nothing narrows it", () => {
		expect(
			linkedinPostsInput(["https://www.linkedin.com/company/a"], {}),
		).toEqual([{ url: "https://www.linkedin.com/company/a" }]);
	});

	test("carries the date window and the authored-only switch", () => {
		expect(
			linkedinPostsInput(["https://www.linkedin.com/in/a"], {
				startDate: "2026-01-01T00:00:00.000Z",
				endDate: "2026-08-01T00:00:00.000Z",
				authoredOnly: true,
			}),
		).toEqual([
			{
				url: "https://www.linkedin.com/in/a",
				start_date: "2026-01-01T00:00:00.000Z",
				end_date: "2026-08-01T00:00:00.000Z",
				only_authored_posts: true,
			},
		]);
	});

	test("omits only_authored_posts when off, rather than sending false", () => {
		const [row] = linkedinPostsInput(["https://www.linkedin.com/in/a"], {
			authoredOnly: false,
		});
		expect(row).not.toHaveProperty("only_authored_posts");
	});
});

describe("linkedinJobsInput", () => {
	// location is the required field, not keyword: a place without a role is a
	// valid search, a role without a place is not.
	test("sends location alone as a valid search", () => {
		expect(linkedinJobsInput({ location: "Berlin" })).toEqual([
			{ location: "Berlin" },
		]);
	});

	test("maps every filter to its snake_case name", () => {
		expect(
			linkedinJobsInput({
				location: "Berlin",
				keyword: "typescript",
				country: "DE",
				timeRange: "Past month",
				jobType: "Full-time",
				experienceLevel: "Entry level",
				remote: "Remote",
				company: "Acme",
			}),
		).toEqual([
			{
				location: "Berlin",
				keyword: "typescript",
				country: "DE",
				time_range: "Past month",
				job_type: "Full-time",
				experience_level: "Entry level",
				remote: "Remote",
				company: "Acme",
			},
		]);
	});
});

describe("chatgptInput", () => {
	// The dataset rejects any other url, so it is never the caller's choice.
	test("pins the url the dataset demands and carries the prompt", () => {
		expect(chatgptInput(["who am i"], {})).toEqual([
			{ url: "https://chatgpt.com/", prompt: "who am i" },
		]);
	});

	test("asks each prompt independently", () => {
		expect(chatgptInput(["a", "b"], {})).toHaveLength(2);
	});

	test("sends web_search only when it is being turned off", () => {
		expect(chatgptInput(["a"], {})[0]).not.toHaveProperty("web_search");
		expect(chatgptInput(["a"], { webSearch: true })[0]).not.toHaveProperty(
			"web_search",
		);
		expect(chatgptInput(["a"], { webSearch: false })[0]).toMatchObject({
			web_search: false,
		});
	});

	test("carries country, follow-up and require_sources", () => {
		expect(
			chatgptInput(["a"], {
				country: "de",
				additionalPrompt: "and in euros?",
				requireSources: true,
			})[0],
		).toMatchObject({
			country: "de",
			additional_prompt: "and in euros?",
			require_sources: true,
		});
	});
});

describe("resolveDataset", () => {
	test("maps a friendly name to its dataset id", () => {
		expect(resolveDataset("reddit")).toBe("gd_lvz8ah06191smkebj4");
		expect(resolveDataset("linkedin-jobs")).toBe("gd_lpfll7v5hcqtkxl6l");
	});

	test("passes an unknown id straight through, so new datasets still work", () => {
		expect(resolveDataset("gd_somethingelse")).toBe("gd_somethingelse");
	});
});

describe("snapshotListQuery", () => {
	test("always sends the dataset", () => {
		expect(snapshotListQuery("gd_x", {})).toBe("dataset_id=gd_x");
	});

	test("adds the filters only when given", () => {
		const query = snapshotListQuery("gd_x", { status: "ready", limit: 5 });
		expect(query).toContain("status=ready");
		expect(query).toContain("limit=5");
		expect(snapshotListQuery("gd_x", {})).not.toContain("status");
	});
});
