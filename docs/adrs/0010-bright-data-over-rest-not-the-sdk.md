# 10. Bright Data over REST, not the SDK

- Status: accepted
- Date: 2026-07-29

## Context

`@brightdata/sdk` is the official TypeScript client and the obvious way to
implement `infer bdata`. It was installed and tried first.

## Decision

Do not use it. Call `POST https://api.brightdata.com/request` directly through
Effect's `HttpClient`, reproducing the SDK's own request construction.

## Consequences

**The SDK cannot run on Bun.** Bun replaces the `undici` package with its own
shim, which exposes only the `redirect`, `retry` and `dump` interceptors and
whose `Agent` has no `compose` method at all. The SDK builds its dispatcher
with `new Agent({...}).compose(dns(), retry({...}))`, so it fails before
issuing a single request:

```
dns is not a function
```

and, once `interceptors.dns` is patched in, immediately after with
`.compose is not a function`.

Patching is not a way out. `interceptors.dns` can be restored — the real
implementation is reachable by deep import, since Bun shims only the bare
`undici` specifier and not its subpaths — but `Agent` is a plain named import
that cannot be rebound from outside the SDK. Making the SDK work would mean
aliasing the whole `undici` specifier through a bundler plugin plus a runtime
preload, or patching the installed package. Both make the dev run and the
released bundle resolve differently, which is exactly the class of divergence
this project avoids.

Going direct costs little, because the surface is tiny: **one endpoint**.
Scraping and search both POST to `/request`; search differs only in building a
search engine URL and defaulting to the SERP zone. The pure functions
`buildSerpUrl` and `requestBody` mirror the SDK's `buildSERPUrl` and
`getRequestBody` exactly, including `brd_json=1` for Google, the `md` →
`markdown` alias, dropping undefined keys, and omitting `data_format` when it
is the default `html`. They are unit tested against those rules.

Default zones match the SDK's: `sdk_unlocker` for scraping, `sdk_serp` for
search.

Going direct also lifts a ceiling. The SDK's `youtube.ts` exposes only three
URL-based collectors and no keyword discovery — discovery is reachable there
only through the generic `discoverBy` / `type: 'discover_new'` options. Against
the Web Scraper API the same call is explicit: `POST /datasets/v3/scrape` with
`type=discover_new&discover_by=keyword`. That endpoint answers inline when it
can and returns `202` with a `snapshot_id` when it cannot, so the client polls
`/datasets/v3/progress/<id>` and then downloads `/datasets/v3/snapshot/<id>`.
Discovery almost always takes the deferred path.

The SDK remains a useful reference. Keeping the repository checked out is
worthwhile when the wire format needs verifying:

```
git clone --depth 1 https://github.com/brightdata/sdk-js /tmp/bright-data-sdk-js
```
