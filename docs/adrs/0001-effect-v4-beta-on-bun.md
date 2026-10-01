# 1. Effect v4 beta on Bun

- Status: superseded in part by [ADR 19](0019-effect-v4-stable.md)
- Date: 2026-07-29

## Context

The CLI needs a typed effect system for error handling and dependency
injection, and a command parser. Effect v4 is still in beta but its
`effect/unstable/cli` module covers commands, flags, arguments and interactive
prompts, which removes a separate CLI dependency.

## Decision

Build on Effect v4 beta with Bun as the runtime, using `effect/unstable/cli`
for the command tree and `@effect/platform-bun` for platform services.

## Consequences

**npm's `latest` tag pointed at Effect v3, not v4.** While v4 was in beta a
plain `bun update --latest` silently *downgraded* `effect` from `4.0.0-beta.x`
to `3.22.0` and `@effect/platform-bun` to `0.91.0`, so upgrades had to name the
`beta` dist-tag. This no longer applies: v4.0.0 shipped and holds `latest`.
What still applies is that both packages must move together — mixing v3 and v4
fails at runtime with confusing iterator errors.

A script outside the project directory resolves `effect` from Bun's global
cache and can pick up a stale v3, so any scratch script importing from `src/`
has to live inside the repo.

Being on a beta meant APIs moved between releases. Two renames bit us going
from beta.33 to beta.102:

| beta.33 | beta.102 |
| --- | --- |
| `ServiceMap.Service` | `Context.Service` |
| `Effect.catchAll` | `Effect.catch` (exported as `catch_ as catch`) |

The move from beta.102 to 4.0.0 renamed far more, including one break that
still typechecks. See [ADR 19](0019-effect-v4-stable.md).

`Command.runWith` already strips `Terminal.QuitError` from the error channel,
so Ctrl-C during a prompt is handled by the framework and must not be caught
by hand. Stdin EOF (Ctrl-D) is *not* covered and surfaces as an interrupt.

Check the API against the source when something does not typecheck: the
canonical v4 repository is `Effect-TS/effect` on `main`. The older
`Effect-TS/effect-smol` repository is archived and should no longer be used as
the reference.
