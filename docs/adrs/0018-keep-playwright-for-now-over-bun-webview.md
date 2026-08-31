# 18. Keep Playwright for now, over Bun.WebView

Date: 2026-08-31

## Status

Accepted. Revisit when the triggers below are met.

## Context

Bun 1.4 ships `Bun.WebView`, headless browser automation built into the
runtime. `render image` and `render pdf` currently auto-install
`playwright-core` in the render child (ADR 12), so replacing it would remove a
dependency from the one place we deliberately install things at runtime.

## Decision

Stay on Playwright. Reconsider when either trigger below fires.

## Consequences

**Every capability we need does exist**, verified against Bun 1.4.0 rather
than read from the release notes:

| need | how | verified |
| --- | --- | --- |
| render our HTML | `navigate()` to a `data:` URL | yes |
| screenshot | `screenshot({ encoding: "buffer", format })` | PNG 680x313 |
| PDF | `cdp("Page.printToPDF")` | 27 KB PDF |
| asset interception | `Fetch.enable` + `addEventListener("Fetch.requestPaused")` + `Fetch.fulfillRequest` | intercepted 1, image loaded |
| content height | `evaluate("document.body.scrollHeight")` | 195 |

Two API details cost time to find. `cdp()` is **Chrome backend only**, so the
zero-dependency WebKit backend can screenshot but cannot do PDF or
interception. And CDP events arrive through `addEventListener` on the
`EventTarget`, not a `cdpOn` method — the obvious guess throws
`view.cdpOn is not a function`.

**The saving is smaller than it looks.** Because `cdp()` forces
`backend: "chrome"`, Chrome remains a requirement exactly as today. What goes
away is the `playwright-core` npm package, already cached after the first
render, not the browser.

**Four things Playwright currently does for us would become ours to own:**

- `page.pdf()` maps paper sizes and CSS units for us. `Page.printToPDF` takes
  **inches** (`paperWidth: 8.27` for A4), while the CLI accepts `--format a4`
  and `--margin 1cm`. We would own a paper-size table and a CSS-unit
  converter, and a wrong margin fails silently.
- `fullPage` does not exist. Workable, since the content height is already
  measured: `resize()` then screenshot.
- `deviceScaleFactor` (our `--scale 2`) becomes
  `Emulation.setDeviceMetricsOverride`.
- `waitUntil: "networkidle"`, our default, has no CDP equivalent — Playwright
  implements it. We would need our own settle heuristic or drop to `load` and
  accept missing fonts and images.

Trading four working, tested behaviours for one cached npm package is not a
good trade today. `screenshot()` also has no `clip`, `fullPage` or `scale`
options yet, which suggests the API is still filling in.

**Revisit when** `Bun.WebView` gains `pdf()` and `fullPage`, or when the
`playwright-core` auto-install measurably slows a first render.

**Unrelated but worth recording from the same review:** `Bun.Image` covers
what `sharp` would, and the WebKit backend is genuinely zero-dependency on
macOS — so a screenshot-only path with no Chrome at all is now possible,
which it was not before.
