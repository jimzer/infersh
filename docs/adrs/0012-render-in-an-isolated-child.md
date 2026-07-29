# 12. Render in an isolated child process

- Status: accepted
- Date: 2026-07-29

## Context

`infer render` turns a TSX composition into an image or a PDF. The best idea
in the earlier `remox` prototype was that a composition could import *any* npm
package — charts, icons, date libraries — and it would just work. It achieved
that by scaffolding a temp project, regex-detecting imports, and running
`bun add` on every render.

Everything else about that pipeline was accidental complexity: an esbuild
subprocess, a code-generated render script assembled by string interpolation,
and an HTTP server started to serve local assets.

## Decision

Flatten the composition with `Bun.build` (`packages: "external"`), stage it in
a fresh temp directory, and hand the whole render to a
`bun --install=fallback` child. The child resolves React, Playwright and the
composition's own imports on demand from Bun's global cache.

Local assets are served by intercepting requests to a virtual origin
(`http://assets.infer.local`), not by an HTTP server.

## Consequences

**`bun --install=fallback` is the whole feature.** It gives the `uv run` model:
missing packages install at runtime from the global cache, so repeat renders
are warm. It removes the dependency-detection regex, the per-render `bun add`,
and the temp *project* — the temp directory now holds only files, never an
install.

**The temp directory is an isolation boundary, not a cache.** Rendering a
composition where it sits lets its project's React resolve alongside the
renderer's, and any hook then fails with:

```
Invalid hook call. … You might have more than one copy of React in the same app
```

That was reproduced with a composition doing nothing but `useState`. Copying
the flattened composition somewhere with no `node_modules` above it makes a
single copy structural rather than something to get right. It follows that the
directory must be fresh per render and that there is nothing to version or
compare.

**The child ships as embedded text.** `import child from "./render-child.ts"
with { type: "text" }` inlines the file's characters without following its
imports, so the child stays a real typechecked, linted file while React and
Playwright stay out of the bundle. Measured: a static `import` of
`react-dom/server` alone adds ~330 KB; the whole text-based approach adds
~19 KB.

Two constraints come with it. A text-imported module is text for the *entire*
build, so no other module may import values from it — `WAIT_EVENTS` and
`PAPER_FORMATS` live in `render.ts` for that reason, while `render-shared.ts`
holds only what the child needs. And TypeScript does not model text imports of
`.ts` files, so the two import lines carry `@ts-expect-error`.

**Playwright cannot be bundled at all.** `playwright-core` statically requires
`chromium-bidi` subpaths that are not in that package's export map, so
`bun build` fails outright — with or without `chromium-bidi` installed. CI
caught this. Auto-installing it in the child sidesteps the problem entirely and
keeps it out of the release artifact.

**Interception replaces the asset server.** No port is bound, nothing is copied,
and `setContent` stays the single code path — `remox` navigated to
`http://localhost:<port>/index.html` when assets existed and used `setContent`
when they did not, so its two modes could diverge. The interceptor also gets a
containment check, which is load-bearing: plain `../` is normalised away by URL
parsing, but a percent-encoded separator (`%2e%2e%2f`) survives as one opaque
segment and decoding revives the traversal. Without the check that request
would serve `/etc/passwd`.

**The process boundary carries data, not source.** The composition path and the
job options cross as `argv` JSON. `remox` interpolated output paths, head HTML
and props into generated code, which is why it had to hand-escape backticks and
`$`.

With no `--height`, the viewport shrinks to `document.body.scrollHeight` so the
image hugs the composition. `documentElement.scrollHeight` reports the viewport
height for short pages and would pad the capture out to 720px.
