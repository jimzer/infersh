# 20. Tailwind v4, inlined into every page

- Status: accepted
- Date: 2026-10-01

## Context

`render image`, `render pdf` and `ui` all styled pages with
`<script src="https://cdn.tailwindcss.com">`. That is Tailwind **v3**, it is
**unversioned** — a render could change without a line of ours changing — and
it needs network: offline, a page is not degraded but entirely unstyled.

A portable `render html` output made the network dependency a defect rather
than an inconvenience, so all three options were weighed for every renderer
at once:

| | CDN script | compile at build time | inline the browser build |
| --- | --- | --- | --- |
| offline | ❌ unstyled | ✅ | ✅ |
| names built at runtime (`` `bg-${c}-500` ``) | ✅ | ❌ | ✅ |
| added to the page | nothing | ~10–20 KB of CSS | 282 KB (75 KB gzipped) |
| extra machinery | none | `bun-plugin-tailwind`, a real install, a native scanner binary per platform | none |

## Decision

Inline Tailwind v4's browser build, `@tailwindcss/browser`, pinned to an exact
version in `src/tailwind.ts`, into every page that uses Tailwind.

- `render image` / `render pdf`: the child resolves `name@version` through
  `bun --install=fallback` — `Bun.resolveSync` with a version suffix installs
  into Bun's cache — reads the file and inlines it.
- `ui`: the package joins the page's `bun install`, and the parent reads it out
  of the staged `node_modules`.

`render video` never had Tailwind and still does not.

## Consequences

**Build-time compilation was rejected for one reason that matters.** It reads
source files as text and never runs them, so it sees `"bg-emerald-500"` in
`open ? "bg-emerald-500" : "bg-rose-500"` but cannot see `bg-sky-500` in
`` `bg-${color}-500` `` — that string only exists once the code runs. The
browser build compiles inside the page and sees whatever reaches the DOM. Bun
has no Tailwind of its own: its support *is* `bun-plugin-tailwind`, which is
build-time compilation with the same limit.

One engine everywhere also means a composition cannot render differently as an
image and as a page.

**Measured, not assumed:** inlined into a page with every request aborted,
styles are applied by the `load` event, about 60 ms after `setContent`, with
zero network attempts. `ui` was driven end to end in headless Chrome: a v4-only
gradient and a runtime-built class both styled, zero external requests, and
the submitted answer came back on stdout.

**v3 compositions can change appearance.** Verified under v4:

- `bg-opacity-*` is gone and silently does nothing; the colour renders opaque.
  The slash form (`bg-black/50`) replaces it.
- A bare `border` takes `currentColor` instead of v3's grey.
- `bg-gradient-to-*` still works alongside v4's `bg-linear-to-*`.

The agent skill documents these, since most Tailwind a model has seen is v3.

**Inlining JavaScript needs one escape.** The HTML parser ends a script element
at the first `</script`, even inside a string, so it is rewritten to
`<\/script` — which means the same thing to JavaScript. The match must keep
its case: a first version lowered `</SCRIPT` and so changed the value of any
string containing it. A test caught that.

`render-shared.ts` is embedded as text (ADR 12) and cannot import
`tailwind.ts`, so the escape exists twice. Both copies are tested.

**`--no-tailwind` no longer means "offline".** The help text used to recommend
it for offline renders; offline now works by default, and the flag only opts
out of Tailwind itself.

Upgrading Tailwind is a one-line change to `TAILWIND_VERSION`. Check the
skill's v3/v4 notes when doing so.
