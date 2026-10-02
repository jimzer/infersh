import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import {
	CHATGPT_ANSWER,
	compactRecords,
	compactSerp,
	LINKEDIN_JOB,
	LINKEDIN_POST,
	missingFields,
	parseFields,
	projectFields,
	REDDIT_COMMENT,
	REDDIT_POST,
	SEARCH_RESULT_SUMMARY,
	X_POST,
	YOUTUBE_COMMENT,
	YOUTUBE_VIDEO,
} from "./listing.ts";

// Fixtures are trimmed from live responses (2026-10-02): the fields each
// shape keeps, plus a few it must drop, under Bright Data's own names.

const youtubeVideo = {
	url: "https://www.youtube.com/watch?v=S2GChOwivwQ&t=35s",
	title: "Effect: the unreadable library that captured my heart",
	youtuber: "@mattpocockuk",
	handle_name: "Matt Pocock",
	video_length: 783,
	likes: 2998,
	views: 85044,
	date_posted: "2025-06-30T06:24:30.000Z",
	transcript: "For about 18 months now, I have been asked...",
	formatted_transcript: [{ start_time: 0, end_time: 5040, text: "For about" }],
	related_videos: null,
	discovery_input: { keyword: "effect typescript", num_of_posts: "1" },
};

const youtubeComment = {
	comment_id: "UgzOwUsBllVms9SoXFh4AaABAg",
	comment_text: "Still using Effect as my daily driver.",
	likes: 43,
	replies: 4,
	username: "@mattpocockuk",
	username_md5: "32a730eee55b0eeba80fdd8ccb4da75a",
	date: "7 months ago (edited)",
	date_iso: "2026-03-02T10:36:11.313Z",
	replies_value: null,
};

const xPost = {
	id: "2105712311063453937",
	user_posted: "OpenAI",
	name: "OpenAI",
	description: "dots demo.\n\nNow... with better WiFi.",
	date_posted: "2026-10-01T17:31:51.000Z",
	photos: null,
	url: "https://x.com/openai/status/2105712311063453937",
	replies: 1187,
	reposts: 717,
	likes: 15032,
	views: 41617,
	followers: 5411721,
	biography: "OpenAI's mission is to ensure...",
	is_repost: true,
};

const redditPost = {
	post_id: "t3_1whpq8m",
	url: "https://www.reddit.com/r/typescript/comments/1whpq8m/understanding_why_youd_use_effect_ts/",
	user_posted: "coopermaruyama",
	title: "Understanding Why You'd Use Effect TS",
	description: null,
	num_comments: 104,
	date_posted: "2026-09-16T06:56:46.510Z",
	community_name: "typescript",
	num_upvotes: 83,
	comments: [{ comment: "interesting take", user_commenting: "someone" }],
	related_posts: [{ community: "Caldruki" }],
	community_members_num: 186291,
};

const redditComment = {
	url: "https://www.reddit.com/r/typescript/comments/1whpq8m/x/pa534xc/",
	comment_id: "pa534xc",
	user_posted: "BeamMeMyPants",
	comment: "Effect makes the hard stuff easy and the easy stuff hard.",
	date_posted: "2026-09-16T11:19:22.000Z",
	replies: [{ reply_id: "pa6mqko", reply: "Agreed" }],
	num_upvotes: 40,
	num_replies: 1,
	community_description: "TypeScript is a language for...",
};

const linkedinPost = {
	url: "https://www.linkedin.com/posts/anthropicresearch_activity-7510400301141598209--ID5",
	id: "7510400301141598209",
	user_id: "anthropicresearch",
	user_name: "Anthropic",
	post_text: "Introducing Claude Sonnet 5.5...",
	post_text_html: "Introducing Claude Sonnet 5.5...<br/>",
	date_posted: "2026-09-28T18:09:28.265Z",
	num_likes: 6676,
	num_comments: 219,
	post_type: "repost",
	top_visible_comments: [{ comment: "Nice" }],
};

const linkedinJob = {
	url: "https://www.linkedin.com/jobs/view/senior-frontend-engineer-4465540013",
	job_posting_id: "4465540013",
	job_title: "Senior Frontend Engineer - React (m/f/d)",
	company_name: "ResearchGate",
	job_location: "Berlin, Berlin, Germany",
	job_summary: "Our mission Help us accelerate scientific collaboration...",
	job_seniority_level: "Associate",
	job_employment_type: "Full-time",
	job_posted_time: "2 weeks ago",
	job_posted_date: "2026-09-18T10:33:23.373Z",
	base_salary: null,
	job_description_formatted: "<section>...</section>",
};

const chatgptAnswer = {
	url: "https://chatgpt.com/?q=In%20one%20sentence",
	prompt: "In one sentence, what is Effect TS?",
	answer_html: "<html>…750 KB of page…</html>",
	answer_text: "Effect-TS is a TypeScript library...",
	answer_text_markdown: "Effect-TS is a **TypeScript library**...",
	citations: [
		{
			url: "https://github.com/Effect-TS/effect",
			title: "Effect-TS/effect",
			description: "GitHub",
			icon: null,
			cited: true,
			position: 1,
		},
	],
	additional_prompt: null,
	additional_answer_text: "ChatGPT said: No internet This may take a while...",
	model: null,
	response_raw: '{"analytics":{}}',
};

describe("compact shapes", () => {
	test("YouTube video: renamed, without the transcript", () => {
		expect(compactRecords(YOUTUBE_VIDEO, [youtubeVideo])).toEqual([
			{
				title: "Effect: the unreadable library that captured my heart",
				url: "https://www.youtube.com/watch?v=S2GChOwivwQ&t=35s",
				channel: "Matt Pocock",
				views: 85044,
				likes: 2998,
				published: "2025-06-30T06:24:30.000Z",
				duration: 783,
			},
		]);
	});

	test("YouTube comment: the ISO date, not the relative one", () => {
		expect(compactRecords(YOUTUBE_COMMENT, youtubeComment)).toEqual({
			text: "Still using Effect as my daily driver.",
			author: "@mattpocockuk",
			likes: 43,
			replies: 4,
			date: "2026-03-02T10:36:11.313Z",
		});
	});

	test("X post: text from description, engagement kept", () => {
		expect(compactRecords(X_POST, xPost)).toEqual({
			text: "dots demo.\n\nNow... with better WiFi.",
			url: "https://x.com/openai/status/2105712311063453937",
			author: "OpenAI",
			date: "2026-10-01T17:31:51.000Z",
			likes: 15032,
			reposts: 717,
			replies: 1187,
			views: 41617,
		});
	});

	test("Reddit post: a null body is left out, embedded comments dropped", () => {
		expect(compactRecords(REDDIT_POST, redditPost)).toEqual({
			title: "Understanding Why You'd Use Effect TS",
			url: "https://www.reddit.com/r/typescript/comments/1whpq8m/understanding_why_youd_use_effect_ts/",
			community: "typescript",
			author: "coopermaruyama",
			date: "2026-09-16T06:56:46.510Z",
			score: 83,
			comments: 104,
		});
	});

	test("Reddit comment: replies is the count, not the nested array", () => {
		expect(compactRecords(REDDIT_COMMENT, [redditComment])).toEqual([
			{
				text: "Effect makes the hard stuff easy and the easy stuff hard.",
				author: "BeamMeMyPants",
				date: "2026-09-16T11:19:22.000Z",
				score: 40,
				replies: 1,
				url: "https://www.reddit.com/r/typescript/comments/1whpq8m/x/pa534xc/",
			},
		]);
	});

	test("LinkedIn post", () => {
		expect(compactRecords(LINKEDIN_POST, linkedinPost)).toEqual({
			text: "Introducing Claude Sonnet 5.5...",
			url: "https://www.linkedin.com/posts/anthropicresearch_activity-7510400301141598209--ID5",
			author: "Anthropic",
			date: "2026-09-28T18:09:28.265Z",
			likes: 6676,
			comments: 219,
			type: "repost",
		});
	});

	test("LinkedIn job: no summary, salary only when published", () => {
		expect(compactRecords(LINKEDIN_JOB, linkedinJob)).toEqual({
			title: "Senior Frontend Engineer - React (m/f/d)",
			company: "ResearchGate",
			location: "Berlin, Berlin, Germany",
			url: "https://www.linkedin.com/jobs/view/senior-frontend-engineer-4465540013",
			posted: "2026-09-18T10:33:23.373Z",
			type: "Full-time",
			seniority: "Associate",
		});
		const salary = { min_amount: 70000, max_amount: 90000, currency: "EUR" };
		expect(
			compactRecords(LINKEDIN_JOB, { ...linkedinJob, base_salary: salary }),
		).toMatchObject({ salary });
	});

	test("ChatGPT: markdown answer and bare citations, no page HTML", () => {
		expect(compactRecords(CHATGPT_ANSWER, chatgptAnswer)).toEqual({
			prompt: "In one sentence, what is Effect TS?",
			answer: "Effect-TS is a **TypeScript library**...",
			citations: [
				{
					title: "Effect-TS/effect",
					url: "https://github.com/Effect-TS/effect",
				},
			],
		});
	});

	test("ChatGPT: the follow-up answer is kept only with a follow-up", () => {
		expect(
			compactRecords(CHATGPT_ANSWER, {
				...chatgptAnswer,
				additional_prompt: "And in Rust?",
				additional_answer_text: "There is no direct equivalent.",
			}),
		).toMatchObject({
			followUp: "And in Rust?",
			followUpAnswer: "There is no direct equivalent.",
		});
	});

	test("a field of the wrong type costs that field, not the record", () => {
		expect(
			compactRecords(X_POST, { ...xPost, likes: "15K", description: null }),
		).toEqual({
			url: "https://x.com/openai/status/2105712311063453937",
			author: "OpenAI",
			date: "2026-10-01T17:31:51.000Z",
			reposts: 717,
			replies: 1187,
			views: 41617,
		});
	});

	test("a failed row keeps its error rather than compacting to nothing", () => {
		const failed = {
			input: { url: "https://x.com/a/status/1" },
			error: "Post not found",
			error_code: "dead_page",
		};
		expect(compactRecords(X_POST, [xPost, failed])).toEqual([
			expect.objectContaining({ author: "OpenAI" }),
			{
				input: { url: "https://x.com/a/status/1" },
				error: "Post not found",
				errorCode: "dead_page",
			},
		]);
	});

	test("anything that is not a row passes through untouched", () => {
		expect(compactRecords(X_POST, "not json")).toBe("not json");
		expect(compactRecords(X_POST, [1, null])).toEqual([1, null]);
	});

	test("the summary --help shows is the compact keys, in order", () => {
		expect(X_POST.summary).toBe(
			"{text, url, author, date, likes, reposts, replies, views}",
		);
		expect(YOUTUBE_VIDEO.summary).toBe(
			"{title, url, channel, views, likes, published, duration}",
		);
		expect(Object.keys(compactRecords(X_POST, xPost) as object)).toEqual(
			X_POST.summary.slice(1, -1).split(", "),
		);
	});
});

describe("compactSerp", () => {
	const serp = {
		general: { search_engine: "google", query: "effect typescript" },
		organic: [
			{
				link: "https://effect.website/",
				display_link: "https://effect.website",
				title: "Effect | Production Grade TypeScript",
				description: "Effect's declarative patterns...",
				extensions: [{ type: "site_link", text: "Why Effect?", rank: 1 }],
				icon: "data:image/webp;base64,UklGRlIBAABXRUJQ",
				rank: 1,
			},
			{
				link: "https://dev.to/effect-ts-in-2026",
				title: "Effect-TS in 2026",
				description: "Functional programming for TypeScript...",
				extensions: [
					{ type: "text", text: "Missing: typescript" },
					{ type: "text", text: "23 Mar 2026" },
				],
			},
		],
		related: [{ text: "Effect typescript example" }],
		pagination: { pages: [] },
	};

	test("keeps title, url, snippet and the date Google shows", () => {
		expect(compactSerp(serp)).toEqual(
			Option.some([
				{
					title: "Effect | Production Grade TypeScript",
					url: "https://effect.website/",
					snippet: "Effect's declarative patterns...",
				},
				{
					title: "Effect-TS in 2026",
					url: "https://dev.to/effect-ts-in-2026",
					snippet: "Functional programming for TypeScript...",
					date: "23 Mar 2026",
				},
			]),
		);
		expect(SEARCH_RESULT_SUMMARY).toBe("{title, url, snippet, date}");
	});

	test("reads a relative date too", () => {
		const recent = {
			organic: [
				{
					link: "https://a",
					extensions: [{ type: "text", text: "3 days ago" }],
				},
			],
		};
		expect(compactSerp(recent)).toEqual(
			Option.some([{ url: "https://a", date: "3 days ago" }]),
		);
	});

	test("unwraps --format json, where the SERP is a JSON string in body", () => {
		const wrapped = {
			status_code: 200,
			headers: {},
			body: JSON.stringify(serp),
		};
		expect(compactSerp(wrapped)).toEqual(compactSerp(serp));
	});

	test("declines a page it cannot read, so the caller prints it as is", () => {
		expect(compactSerp("<html>Bing</html>")).toEqual(Option.none());
		expect(compactSerp({ body: "# markdown" })).toEqual(Option.none());
	});
});

describe("parseFields", () => {
	test("splits, trims and drops empties", () => {
		expect(parseFields(" title, url,,date ")).toEqual(["title", "url", "date"]);
	});
});

describe("projectFields", () => {
	const rows = [
		{ title: "a", url: "https://a", likes: 1 },
		{ title: "b", url: "https://b" },
	];

	test("keeps only the named keys of every row", () => {
		expect(projectFields(rows, ["url", "likes"])).toEqual([
			{ url: "https://a", likes: 1 },
			{ url: "https://b" },
		]);
	});

	test("projects a single row the same way", () => {
		expect(projectFields(rows[0], ["title"])).toEqual({ title: "a" });
	});

	test("follows a dotted path through objects and arrays", () => {
		const answer = {
			prompt: "q",
			citations: [
				{ title: "t1", url: "u1" },
				{ title: "t2", url: "u2" },
			],
			meta: { model: "gpt", region: "us" },
		};
		expect(projectFields(answer, ["citations.url", "meta.model"])).toEqual({
			citations: [{ url: "u1" }, { url: "u2" }],
			meta: { model: "gpt" },
		});
	});

	test("a failed row keeps its error, whatever was asked for", () => {
		expect(
			projectFields(
				[{ error: "gone", errorCode: "dead_page", input: {} }],
				["url"],
			),
		).toEqual([{ error: "gone", errorCode: "dead_page" }]);
	});

	test("leaves values that are not rows alone", () => {
		expect(projectFields("<html>", ["url"])).toBe("<html>");
	});
});

describe("missingFields", () => {
	test("names keys no row has, and the keys that exist", () => {
		expect(
			missingFields(
				[
					{ title: "a", url: "u" },
					{ title: "b", likes: 2 },
				],
				["url", "job_title", "citations.url"],
			),
		).toEqual({
			missing: ["job_title", "citations.url"],
			available: ["title", "url", "likes"],
		});
	});

	test("says nothing when there are no rows to judge by", () => {
		expect(missingFields([], ["url"]).missing).toEqual([]);
	});
});
