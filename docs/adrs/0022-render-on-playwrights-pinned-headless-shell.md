# 22. Render on Playwright's pinned headless shell

- Status: accepted
- Date: 2026-10-01

## Context

`render image` and `render pdf` launched the **system Chrome**, the full
browser in new-headless mode, and fell back to Playwright's own browser only as
a last resort. That made a render depend on whatever Chrome the machine had —
which auto-updates — and fail outright on a machine with none, such as a Linux
server or CI.

`playwright-core` itself was **unpinned**: the child auto-installed whatever
was latest on every render.

Google ships `chrome-headless-shell`, the same Blink and V8 with the browser UI,
sync and extensions removed. Remotion already renders video on it.

## Decision

Pin `playwright-core` (`PLAYWRIGHT_VERSION` in `render.ts`) and launch its
default headless browser, which is the headless shell build that release was
tested against. The order is:

1. `CHROME_PATH`, when set.
2. Playwright's headless shell, downloading it once if it is missing.
3. The system Chrome and the known install paths, if the download fails.

## Consequences

**Measured against the system Chrome**, same page, five runs each:

| | system Chrome | headless shell |
| --- | --- | --- |
| launch, render, screenshot | 527 ms median | 202 ms median |
| launch alone, warm | — | 95 ms |

A full `render image` dropped to about 1.5 s wall clock. The very first launch
of a freshly downloaded shell took 1.8 s, which is macOS vetting a new binary
once.

**The output is not bit-identical, and that is fine.** The largest per-channel
difference across a full-width gradient was 2/255, mean 0.5 — gradient
dithering. Text was identical. Neither PNG carried a colour profile.

**The first render downloads about 200 MB**, taking 46 s here, into Playwright's
cache (`~/Library/Caches/ms-playwright` on macOS, `PLAYWRIGHT_BROWSERS_PATH` to
move it). A 1 MB ffmpeg comes with it whichever install name is used. This is
why the child's stderr is now passed straight through instead of collected
and shown only on failure: a collected minute of silence looks like a hang.
The cost is that a failure prints its reason live and then a generic
"Render failed; see the output above", as video already did.

**Offline is degraded, not broken.** A failed download prints one line — its
reason extracted from Playwright's error dump — and the render proceeds on the
system Chrome. Until the download succeeds, each render retries it, so an
offline machine pays a couple of seconds per render.

**The pin is held in two places.** The child runs `playwright-core@1.63.0` but
is typechecked against the devDependency; a test fails if they differ, since
otherwise the types could describe a different API than the one that runs.
Bumping Playwright also moves the browser build, so check renders after doing
it.

**Video keeps its own shell.** Remotion downloads and pins a separate one, so a
machine using both renderers holds two copies, about 400 MB together. Sharing
one would mean Playwright driving a build it was not released with, or this
CLI owning the download — neither is worth 200 MB of disk.

## Also found while doing this

Image, pdf and video all **dropped imported files**.
`import logo from "./logo.png"` became the string `"./logo-<hash>.png"` naming
a file that the move into the temp directory left behind. Image and pdf
rendered a broken-image icon; video was worse — Remotion's `<Img>` retried for
about 20 seconds and then failed the whole render. All three now use the
exact-path swap to a data URI that `render html` introduced (ADR 21).
