# v2: bundle, release, self-update

## Plan

- [ ] `Justfile` with `checkall` (biome + tsc + tests) and `bundle`
- [ ] Version baked at build time via `bun build --define __VERSION__`, `"dev"` when run from source
- [ ] `just bundle` → single minified `dist/infer.js`, shebang banner, runnable as-is
- [ ] `infer update` — compare against the latest GitHub release, download, atomic self-replace
- [ ] `install.sh` for `curl … | sh`
- [ ] CI workflow on push to main: `just checkall` + `just bundle`
- [ ] Release workflow on published release: bundle at the tag version, attach `infer.js`
- [ ] Point `origin` at `git@github.com:jimzer/infersh.git`
- [ ] Remove the local `bun link` so testing goes through the real install path
- [ ] Push, cut a release, install via curl, verify `infer update` end to end

## Notes

- `bun build --define` works but is undocumented in `--help`.
- `typeof __VERSION__ === "string" ? __VERSION__ : "dev"` keeps source runs working.
- Self-replace must write the temp file in the *same directory* as the target so
  `rename` stays on one filesystem and is atomic.

## Review

(filled in at the end)
