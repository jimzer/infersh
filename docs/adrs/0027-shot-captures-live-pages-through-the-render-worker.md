# 27. `infer shot` captures live pages through the render worker

- Status: accepted
- Date: 2026-10-02

## Context

Screenshotting a live URL — a deployed site, a docs page, the app an agent is
building on `localhost` — meant installing Playwright into a project,
downloading a browser and writing a script, every time. The render worker
already had a pinned headless Chrome (ADR 22), its one-time download and every
fallback.

## Decision

`infer shot <url>` is a job for the same worker. A job carrying a `url`
skips composing markup — React is never imported — and navigates instead; the
capture branches are shared with `render image` and `render pdf`. The worker
reports the final URL, the title and the HTTP status as one JSON line on stdout.

## Consequences

**Nothing new to download or maintain**: the browser, its pin, its offline
fallback and the stdin-tied cleanup are the render worker's. A capture takes
about half a second warm.

**It waits for `load` and for web fonts, not `networkidle`.** `networkidle`
suits the local content `render` loads, but live sites with analytics or
polling never go idle and would time out. Fonts are waited for explicitly
because text set in a web font reflows when it arrives, and `load` does not
always wait for it. `--wait-for <selector>` and `--delay` cover pages that render
later; `--wait networkidle` is still available.

**An error page is captured, not refused.** A 404 or 500 is what the URL shows,
so the image is written — but stderr says so and `--json` carries the status,
so an agent does not mistake an error page for the real one.

The whole page is captured by default, matching `render image`; `--no-full-page`
keeps the viewport and `--selector` a single element. A bare address gets a
scheme: `http://` for this machine, `https://` otherwise.

Verified against a local page built to exercise every option — full page,
viewport, phone width at 2x, one element, dark mode, content rendered 1.5 s
after load, PDF, JPEG, a 404, a missing selector — with sizes checked exactly,
and against example.com, bun.com/docs and effect.website.
