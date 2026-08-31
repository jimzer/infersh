# infer bdata

Bright Data: fetch pages that block plain requests, query search engines, and
collect structured records from YouTube, X, Reddit and LinkedIn.

```bash
infer bdata scrape https://example.com --data-format markdown
infer bdata search "pizza restaurants" --format json
infer bdata youtube video https://youtu.be/dQw4w9WgXcQ
infer bdata youtube discover "ai tools" --num-of-posts 20
infer bdata x profile https://x.com/OpenAI --limit 10
infer bdata reddit search "effect typescript" --num-of-posts 20
infer bdata linkedin jobs --location Berlin --limit 25
infer bdata chatgpt "what changed in AI agents this month?"
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
infer bdata youtube comments <url>... --limit 100             # the reaction
```

`video` already returns the transcript, so reach for `comments` when you want
the audience's reaction rather than the content. It is a different dataset with
its own shape — one row per comment — and it requires `--limit` even though the
URL is known, because a popular video holds tens of thousands of them.

**`discover` requires `--num-of-posts`.** The API treats an absent limit as
*unlimited* and bills per collected video, so the limit has to be stated. Pick a
small number: 10–20 is plenty to survey a topic. Narrow further with
`--start-date` / `--end-date` rather than raising the limit.

`discover` is queued rather than answered inline — the job is polled for up to
ten minutes, with progress on stderr. `video` usually answers immediately. Both
print JSON to stdout, so `| jq '.[].url'` works.

## x

X (Twitter) posts, as structured records with full engagement metrics.

```bash
infer bdata x post <post-url>...                    # you already know the URLs
infer bdata x profile <profile-url>... --limit 10   # latest posts per account
```

**There is no keyword search for X.** Bright Data does not offer one, and no
flag here will find posts about a topic. Use Google instead, then collect what
it returns:

```bash
infer bdata search 'site:x.com effect after:2026-08-01'
infer bdata x post <the /status/ URLs it found>
```

`profile` walks each account separately, so `--limit` applies per profile and
several accounts in one call collect up to that many each:

```bash
infer bdata x profile https://x.com/OpenAI https://x.com/AnthropicAI --limit 5
```

Pass every account you want in one call rather than running the command
repeatedly — the rows are processed together and it usually answers within a
minute.

`--limit` is required, because a profile has no natural end and every record
is billed. `--start-date` / `--end-date` narrow the window further.

## reddit

Reddit posts and comments. Reddit blocks unauthenticated fetching, so this is
the route to its content — do not try WebFetch first.

```bash
infer bdata reddit search "effect typescript" --num-of-posts 20 --date "Past week"
infer bdata reddit subreddit https://www.reddit.com/r/typescript/ --limit 25 --sort Hot
infer bdata reddit post <post-url>...
infer bdata reddit comments <post-url>... --limit 50 --sort Top
```

Unlike X, Reddit **does** support keyword search, so `search` is the direct
route to "what is being said about this".

`post`, `search` and `subreddit` all return the same post record — title,
body, score, comment count, community and member count. `comments` is a
different dataset with a different shape: one row per comment, with its text,
author, score and nested replies.

The usual pipeline is discovery then depth. `search` or `subreddit` finds
posts; the discussion worth reading is in `comments`, so pass the URLs you
care about on:

```bash
infer bdata reddit subreddit https://www.reddit.com/r/rust/ --limit 10 --sort Hot \
  | jq -r '.[].url' | xargs infer bdata reddit comments --limit 30
```

Two things that trip people up:

- **`--sort` values are capitalised**: `Hot`, `New`, `Top`, `Rising`. Bright
  Data's own docs list `new`, `top`, `hot`; the API rejects all three.
- **`comments` requires `--limit` even though you passed a URL.** A busy thread
  holds thousands of comments and each is billed. `--sort` decides which ones
  the limit keeps; `--days-back` narrows by age instead.

`--date` on `search` takes one of `Past hour`, `Past day`, `Past week`,
`Past month`, `Past year`, `All time`, spelled exactly like that.

## linkedin

Companies, people, what they post, and what they are hiring for.

```bash
infer bdata linkedin company <company-url>...
infer bdata linkedin profile <people-url>...
infer bdata linkedin posts <url>... --limit 20
infer bdata linkedin jobs --location Berlin --limit 25 [--keyword "..."]
```

LinkedIn blocks ordinary fetching, and a `site:linkedin.com` search returns
titles without post text or job details. This is the only route to it.

`posts` picks its route from the URL — `/company/` pages one way, `/in/` people
another. They cannot be mixed in one call, and a URL that is neither is an
error rather than an empty result. `--authored-only` drops reshares on the
people route, which is what you want when judging what someone actually thinks.

**`jobs` needs `--location`, not `--keyword`.** Searching a place without a
role is valid; a role without a place is not. This is the sharpest
competitive-intelligence tool here: what a company is hiring for tells you what
it is building, often months before anything ships.

```bash
infer bdata linkedin jobs --location "United States" --company OpenAI \
  --limit 50 --time-range "Past month" | jq -r '.[].job_title'
```

`profile` returns personal data — employment history, education, skills.
Collect what a question needs rather than sweeping profiles up.

## chatgpt

Ask an answer engine and get its answer *and its sources* as data.

```bash
infer bdata chatgpt "What are the best TypeScript effect systems in 2026?"
infer bdata chatgpt "best CRM for small teams" --country de
```

Returns `answer_text`, `answer_text_markdown`, `answer_html`, and `citations`
with titles and URLs. **Billed per prompt, not per token**, so a question's
cost does not depend on how long the answer turns out to be.

Two ways to use it:

- **As discovery.** The citations are a ranked reading list assembled by
  something that already read them. Pipe them onward:

  ```bash
  infer bdata chatgpt "who is winning at AI agents?" | jq -r '.citations[].url' \
    | xargs infer bdata scrape --data-format markdown
  ```

- **As monitoring.** "What does ChatGPT say about us" is now a question with an
  answer, and `--country` makes it comparable across markets.

Web search is on by default and is what produces citations. `--no-web-search`
shows what the model says unaided; `--require-sources` fails rather than
returning an unsourced answer.

## snapshot

Discovery jobs are queued and polled for **ten minutes**. A job that outlives
that is **not lost** — it keeps running on Bright Data's side.

```bash
infer bdata snapshot list --dataset reddit --status ready
infer bdata snapshot status sd_abc123
infer bdata snapshot get sd_abc123        # download it
infer bdata snapshot cancel sd_abc123     # stop it billing
```

When a command prints `Snapshot sd_… was still running after 10 minutes`, that
is the recovery path: wait, then `snapshot get`. **Do not re-run the original
command** — that pays for the same work twice.

`--dataset` takes a friendly name (`x`, `reddit`, `youtube`, `linkedin`,
`chatgpt`, …) or a raw `gd_` id. Listing and status cost nothing, so checking
is always cheaper than guessing.

`cancel` is the only brake on a discovery run that is larger than you meant.
Records already collected are still billed; cancelling stops it going further.

## The research pipeline

Answering "what is happening with X" is two phases: **discover** the links,
then **fetch** what is behind them. The commands above are the pieces; this is
how they compose.

### 1. Discover

Pick whichever routes fit the question, and use several:

```bash
infer bdata search "effect typescript v4" --json           # the open web
infer bdata chatgpt "what is new in effect typescript?"    # a sourced summary
infer bdata search 'site:x.com effect after:2026-07-25'    # X posts, via Google
infer bdata scrape https://news.ycombinator.com --data-format markdown
infer bdata youtube discover "effect typescript" --num-of-posts 10
infer bdata reddit search "effect typescript" --num-of-posts 10
```

`chatgpt` is worth running first on an unfamiliar topic: its citations are a
reading list assembled by something that already read them, which beats
guessing which of ten blue links matters.

Google operators all work through `search` — `site:`, `after:`, `-exclude`,
`"exact phrase"`, `OR`, `inurl:` — because the query is passed through
untouched. `site:x.com … after:` is the only way to find X posts *by topic*,
since Bright Data has no keyword search for X; feed the `/status/` URLs it
returns into `x post` for full engagement metrics. To follow accounts rather
than topics, use `x profile` directly.

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
| Reddit | blocks unauthenticated fetching; use `reddit post`, and `reddit comments` for the discussion |
| YouTube | use `youtube video`, which returns structured data *and the transcript* rather than page HTML |
| X / Twitter posts | use `x post`, which returns engagement metrics a page fetch could not give you |
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
