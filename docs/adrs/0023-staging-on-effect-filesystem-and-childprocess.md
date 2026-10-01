# 23. Staging on Effect's FileSystem and ChildProcess

- Status: accepted
- Date: 2026-10-02

## Context

`render` and `ui` each stage a TSX file in a throwaway directory, install its
packages there and hand it to a child process. Each had its own copy of every
step — a temp directory with `acquireUseRelease` and `rmSync`, a `Bun.write`
wrapper, a `bun install` runner — and nine raw `Bun.spawn` calls between them
and `groq`, each with its own Promise plumbing. `BunServices.layer` already
provided `FileSystem` and `ChildProcessSpawner` to the whole app; nothing
used them.

## Decision

One module, `src/stage.ts`, on Effect's platform services: `tempDir` (a
`makeTempDirectoryScoped`), `writeFile`, `readFile`, `install`, `run`, and
`cacheDir`. `render`, `ui` and `groq` all use it, and their copies are gone.

The `Render` and `Ui` layers capture the platform services when built, so their
methods still need nothing; each method is an `Effect.fn` with a span name,
closed by one step that ends its scope, turns staging errors into its own error
type, and supplies those services.

`ui` now flattens its page with render's `isolateComposition` rather than a
near-copy of it.

## Consequences

**Lifetimes follow scopes.** A render's temp directory is removed, and every
child it started killed, when the render ends — by success, failure or Ctrl-C —
with no cleanup code at the call site. `ui`'s page server is a scoped
`ChildProcess`; the hand-written `proc.kill()` release is gone. Verified: no
temp directory left after any renderer succeeding or failing, and no server
left after an answer, a timeout or Ctrl-C.

**The scoped cleanup does not follow symlinks.** Video symlinks the shared
browser download into each temp directory (ADR 13). Before switching cleanup
mechanisms this was tested directly: a symlinked directory's contents survive
the scope closing.

**Two bugs went with the duplication.** `ui` flattened its page with its own
pass, which dropped imported files and took `outputs[0]` as the code — the CSS
output when a page imported CSS. Reusing render's pass fixed both, and the page
now links the CSS it imported. And the video child's stdout was a pipe nobody
read, which blocks a child once enough is written to it; it is now discarded.

**Polling became a retry.** Waiting for `ui`'s server to report its port is an
`Effect.retry` — every 50 ms, up to 300 times, only while the child is alive —
and a half-written `ready.json` is a retried failure rather than an exception
from `JSON.parse` that crashed the CLI.

**Effect Schema was tried for that and first rejected on size — wrongly.**
Decoding those two files with it appeared to add 146 KB to the bundle and
about 6 ms to every command's startup. That was Bun 1.4.0's bundler. Rebuilt
with Bun 1.4.2, the same change costs about 2 KB and 0.4 ms, because 1.4.2
tree-shakes Effect far better — the whole bundle fell from 978 KB to 786 KB on
the upgrade alone. Schema is now used for all parsing; see ADR 24. Compare
bundle sizes only between builds made with the same Bun.

**`ChildProcess` had a measured cost too**, on Bun 1.4.0: Effect's Stream
machinery, +67 KB and about 3 ms of startup, paid knowingly for scoped process
lifetimes. With provider keys now read on first use (`lazyKey` in
`secrets.ts`), startup was still lower than before this work: 80 ms → 69 ms
median for `infer --version`. On Bun 1.4.2 it is about 55 ms.
