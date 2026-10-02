# 31. Fetch fal specs ourselves; the OpenAPI parser only dereferences

- Status: accepted
- Date: 2026-10-02

## Context

`fal schema` handed `@readme/openapi-parser` the spec URL and let
`dereference(url)` download and inline it. Bumping the parser from 6.3 to 9.0
(#9) crossed three majors:

- **7.0** — URL fetches go through a "safe URL" resolver: the host is resolved
  with `node:dns/promises`, private addresses are refused, and the request is
  pinned to the resolved addresses with an `undici.Agent` (imported
  dynamically). Forced on; `resolve.http` options cannot turn it off.
- **7.0.1** — filesystem `$ref`s (`file://`) are off by default.
- **8.0 / 8.0.2** — orphaned `$id` keywords are dropped when bundling,
  validating or dereferencing.
- **9.0** — no code change: Vitest 5 in the repo, a fixed-group major.
- Also since 6.3.1: `@apidevtools/json-schema-ref-parser` 15 (ESM-only), which
  pulls in `undici` 6 and `js-yaml` 5. Published `engines` is still Node ≥ 20.

## Decision

Fetch the spec with Effect's `HttpClient`, check it is an OpenAPI document with
`Schema.is` (ADR 24 — passthrough, so not decoded), and pass the object to
`dereference`. The parser no longer does any I/O for us.

## Consequences

**7.0's resolver breaks every URL fetch under Bun.** Bun answers
`import("undici")` with its own stand-in even when the real package is in
`node_modules`. The stand-in's `Agent` has no `destroy()`, so the resolver's
cleanup throws after a successful download and the call fails with
`ResolverError: Error reading file "https://fal.ai/…"`. The stand-in's `fetch`
also ignores the pinned dispatcher, so the DNS pinning would not have applied
under Bun anyway. Fetching ourselves sidesteps all of it, and the spec request
now gets the same timeout policy as every other provider call (`src/http.ts`).

**Nothing else reaches us.** fal's specs carry only internal `#/components/…`
refs and no `$id`, so the `$id` stripping and the file-resolver change do not
apply. Verified by capturing `fal schema` (default, `--json`, `--full`) for 13
models — image, video, TTS, LLM and the `$ref`-heavy `fal-ai/flux-general` —
before and after: byte-identical from source and from `dist/infer.js`.

**One message changed:** an unknown endpoint now reads
`Could not fetch the schema for <id>: HTTP 404` instead of the parser's
`ResolverError: Error downloading <url>: HTTP ERROR 404`.

**Bundle:** 831,347 → 830,923 bytes. `undici` is imported only by the parser's
URL resolver, through a computed specifier the bundler does not follow.
