# 24. Effect Schema for all parsing

- Status: accepted
- Date: 2026-10-02

## Context

Provider responses, files the CLI writes for itself, and JSON flags were read
by hand: about thirty `as { … }` casts, `typeof` ladders and bare
`JSON.parse` calls across openrouter, budget, fal, bdata, update, autoupdate,
secrets, ui and four commands. Each one restated a shape in imperative code,
and some trusted a shape without checking it at all — fal's model search
result was a straight `as unknown as ModelSearchResult`.

## Decision

Every shape the CLI reads is declared as an Effect Schema and decoded.
`src/json.ts` holds what the call sites share:

- `JsonText` — JSON text to `unknown`, so malformed text is a decode failure
  rather than a thrown `SyntaxError`; compose it with a schema to check shape.
- `JsonObject` — a JSON object, not an array, `null` or a primitive.
- `lenient(schema)` — an optional field kept when it decodes and dropped when
  it does not.
- `decodeEach(schema)` — decodes list elements one by one, keeping those that
  decode.

The existing parse functions keep their names and return types, so their
tests — unchanged — pin the behaviour across the rewrite.

## Consequences

**Leniency is now declared rather than implied.** The hand-written parsers
were deliberately forgiving in places: a Bright Data `credit` that arrived as a
string dropped that detail, not the whole balance; one malformed model dropped
that model, not the catalogue. A plain Schema fails the whole decode on either.
`lenient` (`optionalKey` plus `catchDecoding` returning `None`) and
`decodeEach` reproduce that exactly, and say so where they are used. Required
fields stay strict.

**A schema rebuilds what it decodes, so passthrough data is checked with
`Schema.is` instead.** v4 dropped `onExcessProperty: "preserve"`; decoding
strips undeclared fields at every depth. `fal models --json` promises the full
metadata, so fal's search result is validated with `Schema.is`, a type guard
that leaves the value untouched, and declares only the fields the CLI reads —
an unexpected change elsewhere in fal's metadata cannot break the command.

**Types come from the schemas** where the schema is the authority, as with
fal's `ModelSearchResult`, rather than an interface kept in step by hand.

**The cost is negligible on Bun 1.4.2**: about 2 KB of bundle and 0.4 ms of
startup over the hand-written parsers, measured with both bundles built by the
same Bun. An earlier measurement of 146 KB was Bun 1.4.0's bundler (ADR 23).

**Two places still parse by hand, by necessity.** The render and ui children
are embedded as text and run without Effect available, and the page entry and
`ui` harness run in the browser. Both parse with `JSON.parse`.

Every rewritten parser was exercised against its live API: budget's three
balances, openrouter's catalogue, endpoints and responses (string prices,
reasoning tokens), fal's search with `--json` keeping its full metadata, fal's
OpenAPI extraction, GitHub's release, Bright Data's bodies, Groq's JSON, and
`ui`'s two files.
