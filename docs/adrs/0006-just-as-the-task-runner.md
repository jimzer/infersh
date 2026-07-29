# 6. Just as the task runner

- Status: accepted
- Date: 2026-07-29

## Context

Lint, typecheck, test and bundle need one entrypoint that developers and CI
both use, so that "green locally" and "green in CI" mean the same thing.

## Decision

A `Justfile` is the single entrypoint. `just checkall` runs Biome, `tsc` and
the test suite; `just bundle [version]` builds the release artifact. Both CI
and the release workflow invoke these same recipes rather than reimplementing
the steps in YAML.

`checkall` includes the tests, even though the name only promises lint and
typecheck — otherwise the suite would never run in CI.

## Consequences

Recipes call tools through `bunx`. Unlike `package.json` scripts, a Just
recipe does not get `node_modules/.bin` on its PATH, so a bare `tsc` fails
with `command not found` — and a bare `biome` may silently resolve to a
*globally* installed version instead of the pinned one.

Build output has to be excluded from the tools explicitly. Biome does not read
`.gitignore` by default (`vcs.useIgnoreFile` must be enabled) and lints
`dist/` otherwise, producing hundreds of errors from the minified bundle.
`tsconfig.json` has `allowJs: true`, so it needs `include`/`exclude` for the
same reason.

CI additionally smoke-tests the built bundle (`--version`, `--help`,
`keys list`) rather than only building it. That is what surfaced the missing
credential store on Linux described in ADR 2.
