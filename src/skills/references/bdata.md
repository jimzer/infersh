# infer bdata

Bright Data: fetch pages that block plain requests, query search engines, and
collect structured YouTube data.

```bash
infer bdata scrape https://example.com --data-format markdown
infer bdata search "pizza restaurants" --format json
infer bdata youtube video https://youtu.be/dQw4w9WgXcQ
infer bdata youtube discover "ai tools" --num-of-posts 20
```

Needs `BRIGHTDATA_API_KEY`.

## scrape

For pages a plain fetch cannot get — anti-bot protection, geo-gating, heavy JS.

- **`--data-format markdown` when feeding a page to a model.** Far fewer tokens
  than HTML and keeps the structure. This is usually what you want.
- `--format json` wraps the result in a structured object; `raw` (the default)
  returns the content directly.
- `--country gb` routes the request through that country, changing geo-targeted
  content.
- Several URLs in one call are fetched in parallel and returned as an array, in
  the order given. Prefer one call with many URLs over many calls.

## search

Returns the search engine results page, not a curated answer.

- `--format json` for anything programmatic.
- `--engine google|bing|yandex`, default google.
- `--num-results` defaults to 10, capped at 100.
- Several queries in one call run in parallel.

## youtube

Two subcommands over the same dataset, returning the same record shape — title,
channel, views, likes, duration, publish date, description, tags, thumbnail,
subscriber count and transcript.

```bash
infer bdata youtube video <url>...              # you already know the URLs
infer bdata youtube discover <keyword>... --num-of-posts 20   # find them
```

**`discover` requires `--num-of-posts`.** The API treats an absent limit as
*unlimited* and bills per collected video, so the limit has to be stated. Pick a
small number: 10–20 is plenty to survey a topic. Narrow further with
`--start-date` / `--end-date` rather than raising the limit.

`discover` is queued rather than answered inline — the job is polled for up to
ten minutes, with progress on stderr. `video` usually answers immediately. Both
print JSON to stdout, so `| jq '.[].url'` works.

## The research pipeline

Answering "what is happening with X" is two phases: **discover** the links,
then **fetch** what is behind them. The commands above are the pieces; this is
how they compose.

### 1. Discover

Pick whichever routes fit the question, and use several:

```bash
infer bdata search "effect typescript v4" --json           # the open web
infer bdata search 'site:x.com effect after:2026-07-25'    # X posts, via Google
infer bdata scrape https://news.ycombinator.com --data-format markdown
infer bdata youtube discover "effect typescript" --num-of-posts 10
```

Google operators all work through `search` — `site:`, `after:`, `-exclude`,
`"exact phrase"`, `OR`, `inurl:` — because the query is passed through
untouched. `site:x.com … after:` is the cheap way to find recent X posts, and
the `/status/` URLs it returns can be collected for full engagement metrics.

Scraping a **listing page** — Hacker News, a subreddit, a blog index, a
changelog — is often better discovery than a search, because it is what a human
would actually read. Ask for markdown and the links come back as
`[title](url)`.

Then read the results and choose which links are worth opening. That judgment
is yours; there is deliberately no `--extract-links` flag.

### 2. Fetch — try the free tool first

**Do not reach for `bdata scrape` immediately.** For ordinary websites, use
your own `WebFetch` first: it costs nothing and is usually faster.

Fall back to `infer bdata scrape` when WebFetch:

- is **blocked** — 403, a bot-check page, a consent wall, a redirect loop
- returns **empty or near-empty content** because the page renders with JS

Those two symptoms are the whole rule. Everything else, WebFetch handles.

**Go straight to `bdata` — do not try WebFetch — for:**

| target | why |
| --- | --- |
| Reddit | blocks unauthenticated fetching |
| YouTube | use `youtube video`, which returns structured data *and the transcript* rather than page HTML |
| X / Twitter posts | not fetchable; use the YouTube-style dataset route or SERP discovery |
| anything that already failed once | do not retry WebFetch on it |

When you do scrape, batch it. One call with many URLs runs them in parallel at
a default concurrency of 10, so ten pages take about as long as one:

```bash
infer bdata scrape URL1 URL2 URL3 --data-format markdown --json
```

### The trap: a failed fetch looks like a success

A blocked or missing page comes back as a **short, valid document**, with no
error field:

```
43 chars :: # 404 Page not found [Take me home](/)
```

Bright Data returned 200 because it did fetch the page — the page was a 404.
Nothing in the response says so. **Check the length of each document before
treating it as content.** A few hundred characters where you expected an
article means the fetch failed, and the fix is a different URL, not a retry.

The same shape appears elsewhere: an empty result array rather than an error.
Count rows, do not assume.

A genuinely blocked *site* does report loudly — `bad_endpoint: not available
for immediate access mode in accordance with robots.txt` — which is the good
case, because you can see it.

## Cost

Every call is billed per record or per request. Roughly `1 + N` requests for a
discovery run: one search or listing page, then one per link fetched. Three
habits:

- **Let WebFetch do the free work.** Every page it handles is a request you did
  not pay for.
- Ask for the smallest useful number of records, then widen if needed.
- Reuse a result rather than re-fetching. If you already scraped a page, keep
  the text.
