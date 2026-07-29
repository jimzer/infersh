# v2: bundle, release, self-update

## Plan

- [x] `Justfile` with `checkall` (biome + tsc + tests) and `bundle`
- [x] Version baked at build time via `bun build --define __VERSION__`, `"dev"` when run from source
- [x] `just bundle` → single minified `dist/infer.js`, runnable as-is
- [x] `infer update` — compare against the latest GitHub release, download, atomic self-replace
- [x] `install.sh` for `curl … | sh`
- [x] CI workflow on push to main: `just checkall` + `just bundle` + smoke test
- [x] Release workflow on published release: bundle at the tag, verify version, attach `infer.js`
- [x] Point `origin` at `git@github.com:jimzer/infersh.git`
- [x] Remove the local `bun link` so testing goes through the real install path
- [x] Push, cut releases, install via curl, verify `infer update` end to end

## What the end-to-end testing caught

**1. `--banner` produced an invalid bundle.** Bun already carries the shebang
over from `src/main.ts` and adds a `// @bun` marker, so the banner landed a
second `#!/usr/bin/env bun` on line 3 — a shebang below line 1 is a syntax
error and the bundle would not start at all. No banner needed.

**2. No credential store on headless Linux.** CI died with
`libsecret not available`. Containers, servers and some WSL setups have no
keyring daemon, so `keys list` now falls back to environment variables and
says so rather than failing.

**3. `releases/latest/download/…` serves a stale asset.** After publishing
v0.2.1 the API reported v0.2.1 as latest while that URL still returned the
v0.2.0 bundle. `infer update` printed "Updated to v0.2.1" and left v0.2.0 in
place. Both `update` and `install.sh` now read the tag from the API and fetch
the immutable `releases/download/<tag>/infer.js`.

`raw.githubusercontent.com` caches too (a few minutes), so a freshly pushed
`install.sh` is not immediately what `curl | sh` gets.

## Verified

- `just checkall` green; 25 tests.
- CI green on main; release workflow green for v0.2.0 → v0.2.3.
- `curl | sh` installs to a clean directory and reports the right version.
- `infer update`: v0.2.2 → v0.2.3, inode swapped, idempotent on rerun, no temp
  files left behind, works through a symlink without replacing the link.
- From source: `update` reports only; `update --force` refuses to overwrite
  `src/main.ts`.

## Follow-ups

- v0.2.1–v0.2.3 are throwaway test releases and can be deleted.
- The local `v2` branch is fully merged into `main` and can be deleted.
