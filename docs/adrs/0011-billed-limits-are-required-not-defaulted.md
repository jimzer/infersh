# 11. Billed limits are required, never defaulted

- Status: accepted
- Date: 2026-07-29

## Context

Some provider calls bill per collected record and treat an absent limit as
"no limit". Bright Data's YouTube keyword discovery is the clearest case: the
API documents `num_of_posts` as optional, with "missing value indicates no
limit", and a broad keyword can match an unbounded number of videos.

This CLI is driven by agents as much as by people, and a forgotten flag is a
much likelier mistake than a deliberately huge number.

## Decision

Any parameter that bounds a **billed** quantity is mandatory, at the type level
and at the CLI:

- `DiscoverInputOptions.numOfPosts` is `number`, not `number | undefined`, so a
  discovery input cannot be constructed without one.
- `infer bdata youtube discover --num-of-posts` is a required flag, rejected
  below 1.
- The value is sent **twice**: as `num_of_posts` on each input row and as the
  `limit_per_input` query parameter, so a cap still applies if either is
  ignored server-side.

A bounded default is acceptable where the ceiling is small and hard. Search
already sends `numResults ?? 10` into every engine URL and is capped at 100, so
it can never run away and stays optional.

## Consequences

The failure mode this prevents is silent and expensive: omitting one flag
starts a job that collects and bills for an unlimited number of records, and
nothing in the request looks wrong.

Making the field required in the *type* rather than only in the CLI is what
makes it hold. When the change was made, the compiler immediately failed two
existing tests that built discovery inputs without a limit — the same mistake
a future call site would have made, caught at build time rather than on an
invoice.

The cost is a slightly longer command line for discovery, which is the right
trade when the alternative is an unbounded bill.

Applying this rule to a new provider means asking one question: *does the
absence of this parameter mean "unlimited", and is the quantity billed?* If
both, it is required.
