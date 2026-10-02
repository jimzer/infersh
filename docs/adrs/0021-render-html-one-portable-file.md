# 21. `render html` writes one portable file

- Status: accepted
- Date: 2026-10-01

## Context

`render image` and `render pdf` freeze a composition: whatever state, handlers
or hover effects it had are gone. A report, a dashboard or an explorable chart
wants the opposite, and `infer ui` does not provide it — `ui` asks the user a
question through a server that lives only as long as the command.

The goal was a file that opens anywhere: emailed, archived, double-clicked
from a downloads folder, with no network.

## Decision

`infer render html` takes the same composition and `--props` as image and pdf
and writes a single `.html`:

1. **Flatten** the composition for a browser target, packages external,
   exactly as image and pdf do, so it leaves its project behind (ADR 12).
   Imported files are turned into data URIs (below).
2. **Embed `--assets`** — any string in the code or the props that names a file
   in the asset directory becomes a data URI. This is ADR 8's
   upload-by-existence rule, pointed at a page instead of a CDN.
3. **Install** React, react-dom, the composition's packages and Tailwind into
   the staged directory.
4. **Build** a generated `index.html` + `entry.ts` with Bun's standalone mode,
   `bun build --compile --target=browser --production`, which inlines the module
   script, linked CSS and relative files.
5. **Prepend** Tailwind's browser build to `<head>` (ADR 20), after the build so
   the bundler never parses it.

The composition is **mounted on the client**, not pre-rendered and hydrated. A
composition that touches `window` while rendering would crash a server render,
and interactive ones often do.

## Consequences

**Verified the way a user would hit it.** A composition with state, an
imported image, two `--assets` images (one named in JSX, one in props), a
relative `.tsx` import, an npm package, an imported CSS file and a Tailwind
class built at runtime was rendered, **moved to another directory**, and
opened over `file://` in headless Chrome with every request aborted. All three
images loaded, every style applied, clicks updated state and re-styled the
button, and there were zero network attempts and zero page errors. Props
containing `</script>` arrived intact.

A trivial page is 216 KB (React's production build); Tailwind adds 282 KB. A
warm render takes about a quarter of a second, since no browser is launched.

Three Bun behaviours cost time and are the reason the code looks the way it
does:

**The `dataurl` loader silently empties imports.** On Bun 1.4,
`Bun.build({ loader: { ".png": "dataurl" } })` compiles
`import logo from "./logo.png"` to `var logo = ""` and reports success. The
types omit `dataurl` from `Loader`, correctly. Instead the flatten pass uses the
default loader, which emits each imported file as an asset output and leaves
the exact string `"./logo-<hash>.png"` in the code; that literal is swapped for
a data URI built from the output's own bytes and type. An exact match, not a
guess, and it works for any file type Bun can import. Image, pdf and video
turned out to drop imports the same way, and now share this swap (ADR 22).

**Bun's resolver caches a missing `node_modules` for the life of the process.**
A composition read from stdin is flattened from inside the staged directory,
which makes the resolver look there before anything is installed. Packages
installed afterwards then fail with `Could not resolve: "react"` for any later
`Bun.build` in the same process. Reproduced in isolation: the same directory
and the same install resolve fine when no build touched it first. The
standalone build therefore runs as a separate `bun build` process, which is
also how every other renderer here already works.

**`--compile` does not imply `--production` for a browser target**, despite the
help text. Without `--production` React's development build is inlined and a
trivial page weighs 1 MB. Stranger, `--production --minify` together also
produce the 1 MB build. Only `--production` alone gives 216 KB.

`Bun.build` failures throw an `AggregateError` whose message is only "Bundle
failed"; the real problem is in its `errors`, which are now what gets printed.

**What cannot be embedded.** A path assembled at runtime (`` `img/${n}.png` ``)
is invisible to a source scan, stays relative, and will not load. The skill
tells agents to write paths in full or import them. A future check could open
the result in headless Chrome with the network blocked and report anything it
tried to fetch — the verification above, run on every render. It is not done
yet because it would make html the slowest renderer instead of the fastest.

**Against `ui`.** The two share the browser-bundling half but not their job:
`ui` returns an answer and needs a live server; `render html` returns a file
and needs nothing. A `ui` page cannot simply be exported, since its buttons
post to a server that would not exist. `ui` now reuses this standalone build
and serves the resulting string (ADR 26), which dropped its own `Bun.serve`
HTML bundling.
