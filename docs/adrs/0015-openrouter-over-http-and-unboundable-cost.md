# 15. OpenRouter over HTTP, and why the search command was dropped

## Status

Accepted. Supersedes an earlier version of this ADR that described an
`openrouter research` command; that command was built, measured, and removed.

## Context

`infer openrouter response` sends one prompt to any model OpenRouter fronts,
optionally forcing the answer to match a JSON Schema. Two decisions shaped it,
and a third — a search command — was reversed after measurement.

### The SDK silently drops fields it has not modelled

`@openrouter/sdk` is a reasonable package: ESM, one dependency (`zod`), and Bun
v1+ explicitly supported, unlike the Bright Data SDK. But it is generated, and
its request schemas contain **no `.passthrough()`**. Anything it has not
modelled is stripped before the request leaves the process.

We hit exactly this shape against the Vercel AI Gateway, which drops unknown
fields the same way:

```
tools:[{type:"x_search"}]   → 400  Invalid input: expected "function"
search_parameters:{...}     → 200  "I'll search X for recent posts from @EffectTS_."
                                   …annotations: 0
```

A 200, a fluent answer announcing a search, no search performed, and the run
still billed. A 400 would have been a kindness. This matters beyond X search:
`text.format.json_schema`, which structured output depends on, is **not in
OpenRouter's own documentation** either — it was found by testing the endpoint
directly. An SDK cannot pass through what nobody documented.

### The search command was removed after measuring it

An `openrouter research` command ran Grok with `web_search` and `x_search`
enabled. It worked, and X search genuinely does what nothing else can —
keyword and semantic search over X, which no scraping route offers. It was
removed anyway, because six live runs showed the cost was both high and
uncontrollable:

| query | cost | input tokens |
| --- | --- | --- |
| one handle, dated | $0.0265 | 6,930 |
| plain web question | $0.0572 | 22,346 |
| one handle, "this week" | $0.1763 | 124,155 |
| same query, repeated | $0.1410 | 95,603 |
| **same query + `--from`** | **$0.2128** | **179,783** |
| web + X, date supplied | $0.2092 | 114,661 |

Three findings, in order of how badly they undermined the command:

**Nothing we exposed controlled the cost.** The same query repeated varied 25%.
Adding a date constraint — which we had hypothesised would *reduce* input, and
were one commit away from documenting as a cost rule — made it **51% worse**,
the most expensive run of all. The model responded to a date floor by fetching
reply threads. A rule drawn from two data points did not survive its first test.

**Bright Data already reaches the same content for 1/140th of the price.**
`bdata search 'site:x.com ethereum after:2026-07-29'` returns 10 results, 9 of
them individual `/status/` URLs, hours old, for **$0.0015**. Google's SERP even
carries engagement data (`620+ likes · 1 day ago`). Every Google operator works
through the SERP zone unmodified — `site:`, `after:`, `-exclude`, quoted exact
phrases, `OR`, `inurl:` — because `buildSerpUrl` only URL-encodes the query and
Google parses operators server-side.

**The synthesis was redundant.** This CLI is agent-first; the thing reading its
output is already a model. Paying Grok to summarise sources before handing them
to Claude is paying twice for one reading.

Grok's X search remains genuinely better on coverage — Google indexes only what
has traction, and cannot do semantic search. That is a real loss, accepted
knowingly, and recorded here so it is not rediscovered as an oversight.

## Decision

**Talk to OpenRouter over `HttpClient`, not through the SDK.** Same reasoning
as ADR 10: we send exactly the JSON the API accepts, and nothing between us and
the wire can quietly remove a field. Verified by the structured-output support
that the SDK does not model at all.

**One subcommand, `response`, over the stateless Responses API.** `store` and
`previous_response_id` are rejected with a 400 by design, so there is no
conversation to manage: `--prompt` carries everything.

**`--schema` puts the JSON object on stdout, alone.** Not wrapped, not fenced,
not prefixed with prose — `jq` reads it directly. Reasoning blocks are parsed
out and go to stderr behind `--reasoning`, so stdout stays pipeable whatever
the model emits.

**Validate schemas locally first.** A non-object, a non-object top level, bad
JSON, or a missing `@file` all fail before the key is resolved. Strict mode
makes providers reject these anyway, and a local failure costs nothing.

**Report cost on every call, always to stderr, before any mode returns.** Rates
vary by orders of magnitude between models; a call that cost $0.000015 and one
that cost $0.18 look identical otherwise.

**Search belongs to `bdata`.** Discovery is `bdata search` with Google
operators; hydration is `bdata` collect-by-URL. No LLM in that loop, and no
fifth provider.

## Consequences

- Adding a parameter means editing `responseBody`, with no SDK to wait on.
  Given the SDK omits the parameter structured output depends on, that is a
  feature rather than a cost.
- `text.format.json_schema` is undocumented by OpenRouter and verified only by
  live testing against `openai/gpt-oss-20b`. If it breaks, this is why, and the
  fix is to re-test rather than to consult the docs.
- The output array interleaves `reasoning` and `message` items, and a message
  may hold several `output_text` parts, so text is assembled by walking the
  array rather than read from a fixed index. A response with reasoning but no
  message yields an empty answer, not a crash.
- A non-`completed` status is surfaced as a warning. A truncated JSON answer is
  worse than none, because it fails at the `jq` boundary rather than at ours.
- `OPENROUTER_API_KEY` is a fourth provider, so `keys set/list/rm` and `budget`
  cover it for free. OpenRouter reports `total_credits` and `total_usage`
  rather than a balance, so `budget` derives it — and returns null rather than
  guessing when `total_usage` is missing, since treating that as zero would
  report an entire purchase as still available.
- The removed search command cost about $1 in measurements. That was the price
  of learning that the cheaper tool we already had was also the better one, and
  of catching a cost rule that would otherwise have shipped as guidance.
