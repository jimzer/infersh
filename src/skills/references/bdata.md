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

## Cost

Every call is billed per record. Two habits:

- Ask for the smallest useful number of records, then widen if needed.
- Reuse a result rather than re-fetching. If you already scraped a page, keep
  the text.
