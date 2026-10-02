# 26. `ui` serves one prebuilt page, and reports over stdout

- Status: accepted
- Date: 2026-10-02

## Context

`infer ui` bundled its page through `Bun.serve`'s HTML bundler, on demand at
the first request — a second browser build path beside `render html`'s, with
its own traps (ADR 16). It served about 500 KB uncompressed, which matters over
`--share` on a phone. And the server reported back through files the CLI
polled: `ready.json` for the port, `result.json` for the answer.

## Decision

1. **Build the page with `render html`'s standalone pipeline** (ADR 21): the
   flattened app, the harness, the data slot and any CSS the page imported go
   into one HTML file; Tailwind is prepended afterwards, as for `render html`.
   The child serves that one string.
2. **Serve it gzipped** when the browser accepts it, compressed once up front.
3. **Report over stdout.** The child writes one JSON line when it is listening
   and one with the answer. The CLI reads them as a stream, decoded with
   Schema, and races the "ready" line against the child exiting.

## Consequences

**One pipeline instead of two.** A `ui` page and a `render html` file are built
the same way, so the import, CSS and production-runtime fixes made for one hold
for the other. The child no longer imports the page, needs no packages of its
own, and the `development: false` setting and its reasoning are gone.

**A third of the bytes over the wire.** 499 KB plain, 143 KB gzipped — measured
locally and through a `--share` tailnet URL, where gzip passes through
`tailscale serve` intact.

**No files and no polling.** The port arrives the moment the server writes it,
rather than on the next 50 ms poll, and the answer is read from the same
stream; a server that exits without reporting fails the run at once instead of
after a retry budget. The reader is a scoped fiber, so it ends with the run.

Verified end to end: an answer with an imported image, imported CSS and
Tailwind all applied; `present` mode with its injected Done button and raw-JSON
bar; a broken page's error reaching the terminal; timeout; Ctrl-C and kill -9
leaving nothing behind; and an answer over `--share`.
