# 32. Signals interrupt the whole CLI

- Status: accepted
- Date: 2026-10-02

## Context

`main.ts` ran the CLI with `Effect.runPromise`, which installs no signal
handlers. On SIGINT or SIGTERM, Bun exited with 130 on the spot and no finalizer
ran. Interrupting `media web` mid-encode left the hidden
`.out.partial-<pid>.mp4` and an ffmpeg still encoding. Every scoped temp
directory and every child process (ADR 23) depended on finalizers that a
signal skipped. A terminal's Ctrl-C partly hid this, because it signals the
whole foreground process group. But a signal sent to `infer` alone (an agent
harness stopping it, `kill`) orphaned everything. `each` had worked around it
with its own listener (ADR 28), and `media` recorded the gap (ADR 30).

## Decision

`main.ts` runs the program with `BunRuntime.runMain`. Its SIGINT and SIGTERM
listeners interrupt the main fiber, so every scope closes before the process
exits 130. Its error reporting is off: the program still prints a failure's
message once and turns it into exit 1, so failures stay unchanged. A custom
teardown exits with the program's own code and calls `process.exit` even on
success, so an idle keep-alive socket cannot hold the process open.

`each` drops its own listener. `Effect.onInterrupt` now prints the message
saying the finished rows are kept.

## Consequences

Verified by sending SIGINT to the `bun` process alone (a non-interactive
shell starts background jobs with SIGINT ignored, so a plain `kill -INT` there
tests nothing). The commands tested were `media web` mid-encode, `render video`
during install and at 0% rendering, `render image`, `human ask` and `each`
(including SIGTERM for `media web`). Each exited 130 with no partial file, no
`infer-*` temp directory and no child or grandchild process left. Normal runs
still exit 0, and a failure still exits 1 with one line on stderr.
