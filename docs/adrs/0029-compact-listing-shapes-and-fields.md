# 29. Listing commands print compact shapes, with `--raw` and `--fields`

- Status: accepted
- Date: 2026-10-02

## Context

`infer bdata` printed whatever Bright Data returned. For a listing that is a
lot of text an agent has to read before it can use any of it — and usually
read twice, once to learn the shape and once to write the `jq` that pulls out
the four fields it wanted. Measured on live responses (2026-10-02):

| command | raw | compact |
| --- | --- | --- |
| `chatgpt` (one-sentence answer) | 784 KB | 0.5 KB |
| `youtube discover` (1 video) | 97 KB | 0.3 KB |
| `reddit search` (1 post) | 24 KB | 0.3 KB |
| `search` (Google, 8 results) | 19–33 KB | 2.7 KB |
| `linkedin jobs` (1 job) | 14 KB | 0.3 KB |
| `linkedin posts` (1 post) | 14 KB | 1.3 KB |
| `reddit comments` (2) | 7.4 KB | 1.2 KB |
| `x profile` (1 post) | 1.7 KB | 0.3 KB |

Most of the bulk is not what anyone lists by: ChatGPT's record is the whole
answer page as `answer_html`, a YouTube video carries its transcript twice
(`transcript` and `formatted_transcript`, 55 KB), a Reddit post embeds its
comments and a dozen related posts, a job carries its description as text and
again as HTML, and every Google result has a base64 favicon.

## Decision

**Listing commands print a compact record per result by default.** `--raw`
prints the provider's record unchanged. The listing commands are the ones that
*find* things — `search`, `youtube discover`, `youtube comments`,
`x profile`, `reddit search|subreddit|comments`, `linkedin posts|jobs` — plus
`chatgpt`, whose record is one answer but almost entirely page HTML.

**Commands that collect known URLs keep the full record by default** —
`youtube video`, `x post`, `reddit post` — and take `--compact`. Asking for a
specific video usually means wanting its transcript; asking for a specific
post means wanting all of it. `linkedin company|profile` and `snapshot get` are
documents (or of unknown kind) with no compact shape, and take only
`--fields`. `scrape` returns one page and is untouched.

**`--fields a,b,c` keeps only those keys of each result, of whichever shape
is printed** — compact names by default, Bright Data's own names with `--raw`.
That keeps one rule rather than a second vocabulary, and makes `--raw
--fields transcript` the cheap way to reach a field the compact shape leaves
out. A dotted path reaches into nested objects and through arrays element by
element (`citations.url`, or `organic.link` on `search --raw`). A key no result
has is named on stderr together with the keys that do exist, so a typo or a raw
name asked of the compact shape is caught on the first call. A failed row keeps
its `error` whatever was asked for. Anything beyond picking keys is `jq`'s job.

**Each shape is a Schema over the provider's keys plus a rename table**
(`src/listing.ts`). Decoding strips undeclared fields at every depth, which is
exactly what a compact shape wants — and why `--raw` must never pass through
one. Every field is `lenient`, so `likes: "15K"` costs `likes`, not the post.
The `--help` text is generated from the same table (`shape.summary`), so the
documented shape cannot drift from the printed one. A missing value is left
out rather than printed as `null`. A row Bright Data could not collect is
recognised first and printed as `{error, errorCode, input}`, never compacted
into an empty record that looks like a result with nothing in it.

Names are short and shared across providers — `text`, `url`, `author`,
`date`, `likes`, `comments` (a count) — rather than each dataset's
(`description` is a tweet's text, `comment_text` a YouTube comment's,
`num_upvotes` a Reddit score).

## Consequences

**This is a breaking change** for anyone parsing the old default output of the
listing commands: `jq '.[].job_title'` is now `.[].title`, `chatgpt` no longer
prints `answer_text`, and `search` prints a list of results rather than the
SERP object. It was made the default anyway because the cost it removes is
paid on every call by every agent, and an opt-in flag is one an agent only
finds after paying it. Keys that kept their name (`url`, `title`, `likes`,
`citations[].url`) keep working, which covers most of the documented `jq`
examples; the rest were rewritten. `--raw` restores the old output exactly.

Things learned from the live responses while defining the shapes:

- **Google results have no date field.** The date Google shows under a result
  ("23 Mar 2026", "Mar 23, 2026", "23-Mar-2026", "3 days ago") arrives as an
  extension of `type: "text"`, alongside text extensions that are not dates.
  A four-digit year or "ago" picks it out; it is passed through as shown,
  not parsed.
- **`search --format json` wraps the same SERP as a JSON string in `body`**,
  so compacting decodes it with `Schema.fromJsonString` rather than treating it
  as a different shape. Bing is now requested with `brd_json=1` too and
  compacts the same way (#13). Bright Data answers "JSON output is not
  supported" for Yandex, so Yandex prints as returned, with a note on stderr.
- **A throttled SERP query comes back as plain text with a 200**: "This query
  recently failed and cannot be attempted at this time…". It is not a parsed
  page, so it too prints as returned rather than as an empty list.
- **Google ignores `--num-results`.** `--num-results 3` returned 8 organic
  results. Google itself no longer honours `num`, so the compact list is now
  cut to `--num-results` and paging is `--start` (#11).
- **`reddit search` without `--date` is now rejected** with `date: Required
  field`, although the code omits the key because an empty string was once
  rejected too. It now defaults to "All time", Reddit's own default (#12).
- ChatGPT's `additional_answer_text` holds filler ("ChatGPT said: No internet
  This may take a while…") when there was no follow-up, so the compact shape
  keeps it only alongside `followUp`.
- `Schema.encodeKeys` looked like the way to rename, but it validates the
  encoded side strictly, before `lenient` can catch anything: a `null` in a
  renamed field failed the whole record. Decoding the provider's keys and then
  `Struct.renameKeys` keeps the leniency.

The OpenRouter and fal model lists were already compact (one line per model
by default, and OpenRouter's `--json` is its own curated shape), so they only
gained their `--json` shape in `--help`.
