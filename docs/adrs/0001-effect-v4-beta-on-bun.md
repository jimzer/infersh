# 1. Effect v4 beta on Bun

- Status: accepted
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

**npm's `latest` tag points at Effect v3, not v4.** A plain
`bun update --latest` silently *downgrades* `effect` from `4.0.0-beta.x` to
`3.22.0` and `@effect/platform-bun` to `0.91.0`. The v4 line lives under the
`beta` dist-tag, so upgrades must be `bun add effect@beta @effect/platform-bun@beta`.
Both packages must move together — mixing v3 and v4 fails at runtime with
confusing iterator errors.

A script outside the project directory resolves `effect` from Bun's global
cache and can pick up a stale v3, so any scratch script importing from `src/`
has to live inside the repo.

Being on a beta means APIs move between releases. Two renames already bit us
going from beta.33 to beta.102:

| beta.33 | beta.102 |
| --- | --- |
| `ServiceMap.Service` | `Context.Service` |
| `Effect.catchAll` | `Effect.catch` (exported as `catch_ as catch`) |

`Command.runWith` already strips `Terminal.QuitError` from the error channel,
so Ctrl-C during a prompt is handled by the framework and must not be caught
by hand. Stdin EOF (Ctrl-D) is *not* covered and surfaces as an interrupt.

Check the API against the source when something does not typecheck: the
canonical v4 repository is `Effect-TS/effect` on `main`. The older
`Effect-TS/effect-smol` repository is archived and should no longer be used as
the reference.
