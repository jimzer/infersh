# 1. Effect v4 on Bun

- Status: accepted
- Date: 2026-07-29
- Updated: 2026-10-01 — v4.0.0 shipped; see [ADR 19](0019-effect-v4-stable.md)

## Context

The CLI needs a typed effect system for error handling and dependency
injection, and a command parser. Effect v4's `effect/cli` module covers
commands, flags, arguments and interactive prompts, which removes a separate
CLI dependency.

This was decided while v4 was still in beta and the module lived at
`effect/unstable/cli`. The bet paid off: v4.0.0 shipped on 2026-10-01 and
`effect/unstable/*` graduated to `effect/*`.

## Decision

Build on Effect v4 with Bun as the runtime, using `effect/cli` for the command
tree and `@effect/platform-bun` for platform services.

## Consequences

**Both packages must move together.** `effect` and `@effect/platform-bun` are
versioned in lockstep, and mixing a v3 with a v4 fails at runtime with
confusing iterator errors rather than a clear version complaint.

A script outside the project directory resolves `effect` from Bun's global
cache and can pick up an unrelated version, so any scratch script importing
from `src/` has to live inside the repo.

`Command.runWith` already strips `Terminal.QuitError` from the error channel,
so Ctrl-C during a prompt is handled by the framework and must not be caught
by hand. Stdin EOF (Ctrl-D) is *not* covered and surfaces as an interrupt.

Check the API against the source when something does not typecheck. The
canonical repository is `Effect-TS/effect` on `main`, and a local clone is kept
at `/tmp/effect` for exactly this.

The beta-to-stable upgrade renamed most constructors and changed one default in
a way that still typechecks. [ADR 19](0019-effect-v4-stable.md) has the table
and the failure mode.
