# 17. The social dataset docs are wrong in three places

Date: 2026-08-07

## Status

Accepted.

## Context

`infer bdata x`, `reddit`, `linkedin`, `chatgpt` and `youtube comments` wrap a
dozen Bright Data Web Scraper API routes across eight datasets.

Every route was implemented from the published API reference, and three of the
shapes below were wrong in a way the documentation did not hint at. All were
found by calling the API, not by reading it.

## Decision

Encode what the API actually accepts, and pin each one with a test naming the
documented value it contradicts.

**`profiles_array` takes `urls`, not `url`** — and is not exposed at all. The
docs show one input row per profile keyed `url`. The API answers:

```
["url", "This input should not contain a url field"]
["urls", "Required field"]
```

It wants a *single* row whose `urls` is an array of profiles, which also means
`limit_per_input` bounds the whole job rather than each account. (An earlier
investigation had concluded the route was broken because it returned zero
rows; it was being sent the documented key.)

Getting the shape right was still not enough, because the route is broken on
Bright Data's side. Two accounts at `--limit 2` — the smallest job it can be
given — polled for the full ten minutes and was still running. Recovering the
snapshot afterwards showed how it ended: **896 seconds, zero rows, one error**.

```
Crawler error: waiting for selector ".last-response [data-state="closed"],
h1 + button span[data-namespace="@xai/icons"], form [data-testid="email"] …"
failed: timeout 120000ms exceeded
```

Those are *Grok* selectors and a login form. The route's crawler is pointed at
the wrong site. The same two accounts through `profile_url` answered inline, in
seconds.

So `discover_by=profiles_array` is deliberately not wrapped. `x profile`
already takes many profile URLs in one call, sends one row each, and gives
every account its own `--limit`, which is the better behaviour anyway. A
pooled budget across accounts was the only thing the array route offered, and
it is not worth a command that does not finish. This is recorded so it is not
re-added from the documentation alone.

**Reddit `sort_by` values are capitalised, and there is a fourth.** The docs
list `new`, `top`, `hot`. All three are rejected with "This value is not
allowed". The accepted set is `Hot`, `New`, `Top`, `Rising`. Validation
happens before any work, so probing candidate values costs nothing — worth
remembering the next time an enum is in doubt.

**X discovery accepts `start_date` and `end_date`.** Undocumented on both
discovery routes. They surfaced in a validation error, which echoes the input
row *after* the API has filled in its own schema — a useful trick for learning
a shape the reference does not state.

## Consequences

Fixing `parseBody` was the wider consequence. A dataset job that answers
inline returns **JSON Lines** once there is more than one row: one object per
line, which is not a JSON document. `JSON.parse` fails, the old code fell
through to its raw-text branch, and stdout stopped being a single JSON value —
breaking the contract every command in this CLI promises. `parseBody` now
recognises the format and returns an array, so an inline answer is
indistinguishable from a snapshot download, which already arrived as one.

This bug predates these commands and affected any multi-row inline answer,
including `youtube video` with several URLs. It went unnoticed because the
earlier calls happened to return one row.

Discovery is unbounded on every one of these routes, so `--limit` is required
rather than defaulted, per ADR 11. `reddit comments` requires it too, even
though the post URL is already known: a busy thread holds thousands of
comments and each is billed.

Two limits worth knowing:

- **There is no keyword search for X.** Not a missing flag — Bright Data does
  not offer one. Finding posts by topic means `infer bdata search 'site:x.com
  … after:…'` and then collecting the `/status/` URLs.
- **A timed-out job is no longer lost.** When the poll expires the job keeps
  running on Bright Data's side, so `bdata snapshot get <id>` collects it
  afterwards rather than paying to run the whole thing again. `snapshot list`
  and `status` cost nothing, and `cancel` is the only brake on a run that is
  collecting more than intended. This is not a niche path: `youtube comments`
  on a single popular video outlived the ten-minute poll on its first real
  call.
