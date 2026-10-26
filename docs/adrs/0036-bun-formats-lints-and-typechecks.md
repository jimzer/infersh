# 36. Bun formats, lints and typechecks: Biome and `tsc` removed

- Status: accepted
- Date: 2026-10-26

## Context

`just checkall` ran three tools: Biome (format, lint, import order), `tsc`
(types) and `bun test`. Bun 1.4 added `bun fmt` (Prettier's output) and
`bun check` (TypeScript 7's checker, built in, no `typescript` package
needed), and its canary adds `bun lint` (ESLint and typescript-eslint rules,
run natively). One runtime that is also the whole toolchain means one version
to keep current and nothing to resolve through `node_modules/.bin` (ADR 6).

Measured on this repo before switching:

- `bun check` reported exactly what `tsc --noEmit` did — nothing on the
  repo, and the same two lines, byte for byte, for planted errors (one of them
  only `noUncheckedIndexedAccess` catches) — in 0.13 s against 0.62 s.
- `bun fmt` with tabs changed four TypeScript files (a few lines rewrapped)
  and was stable on a second run. Import sorting matched Biome's order and
  only added a blank line between groups.
- `bun lint`'s defaults missed four things Biome's recommended set caught on
  planted code — `==`, `a === a`, string concatenation, non-null `!` — and
  caught empty blocks Biome did not. The four rules are turned on in
  `bunfig.toml`, after which it caught everything Biome did.

## Decision

**`bun fmt`, `bun lint` and `bun check`, configured in `bunfig.toml`;
Biome, `biome.json` and the `tsc` step removed.**

- `just lint` formats, then lints with `--fix --max-warnings 0`: the repo
  has no warnings, so a new one fails rather than piling up.
- Markdown is not formatted. `bun fmt` would reformat every doc: tables padded
  to their widest cell (the skill's area table becomes far wider than a screen), and a
  wrapped list line moved to column 0. Biome never touched Markdown either.
- Suppressions are ESLint comments with the reason after `--`, as Biome's
  carried one after `:`.
- `typescript` stays a peer dependency only so editors run the TypeScript
  `bun check` matches (`bun -p process.versions.typescript`).

## Consequences

- **`bun lint` is canary-only for now.** On stable 1.4.4, `bun lint` is not a
  command, so Bun falls back to `bun run lint` — with a `lint` script in
  `package.json` that ran Biome, and without one it fails with `Script not
  found "lint"`. CI runs on canary until a stable release has it; release
  builds stay on stable, because the bundle records the Bun it was built with
  and warns users on an older one.
- **A project script shadows the built-in.** Even where `bun lint` exists, a
  `lint` (or `check`) script in `package.json` runs instead, so those scripts
  are gone; `--no-script` did not override it on 1.4.4.
- CI used to pass with unformatted code, because `just lint` fixes in place.
  It now fails when `just checkall` leaves a diff.
- `--type-aware` was tried and left off: 87 findings, mostly every use of a
  text import being `any` behind its `@ts-expect-error`. A few were real (an
  un-awaited promise in `ui-child.ts`) and are worth a separate pass.
