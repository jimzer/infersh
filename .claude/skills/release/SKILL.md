---
name: release
description: Cut a release of the infer CLI. Reads the full diff since the previous release, classifies it into breaking changes / features / fixes, computes the next semver number from what actually changed, writes user-facing release notes, publishes the GitHub release, then smoke tests it by updating this machine's own install through the official channel. Use when asked to release, cut a release, ship a version, or publish a new version.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
user-invocable: true
---

# Release the infer CLI

Releases are cut from `main`. Publishing a GitHub release triggers
`.github/workflows/release.yml`, which bundles the CLI stamped with the git
tag, asserts the binary reports that tag, and attaches `infer.js`. The tag is
the source of truth for the released version — see `docs/adrs/0003` and
`docs/adrs/0004`.

Never guess the version or the notes. Both are derived from the diff.

## 1. Preflight

```bash
git branch --show-current          # must be main
git status --short                 # must be empty
git fetch --tags --prune && git status -sb | head -1   # must be up to date with origin
gh run list -R jimzer/infersh --limit 1 --json status,conclusion,displayTitle
```

**`git fetch --tags` is mandatory.** Releases are created server-side with
`gh release create`, so a local checkout often has *no tags at all* and
`git describe` fails with "No names found". Fetch before anything reads tags.

Stop and report if the tree is dirty, the branch is not `main`, HEAD is not
pushed, or the latest CI run on `main` failed. Do not release over red CI.

## 2. Establish the baseline

```bash
PREV=$(gh release list -R jimzer/infersh --limit 1 --json tagName --jq '.[0].tagName')
git log --oneline "$PREV"..HEAD
git diff --stat "$PREV"..HEAD
```

If there are no commits since `$PREV`, say so and stop — there is nothing to
release.

## 3. Read the actual diff

```bash
git diff "$PREV"..HEAD -- src/          # behaviour
git diff "$PREV"..HEAD -- Justfile .github/ install.sh   # build and delivery
git log "$PREV"..HEAD --format='%s%n%b'                  # intent
```

Read the real diff, not just the commit subjects. Commit messages describe
intent; the diff describes what users get. A commit titled "refactor" that
changes a flag name is a breaking change, and a "fix" that adds a subcommand
is a feature.

## 4. Classify every change

Sort each change into exactly one bucket:

- **Breaking** — a removed or renamed command, subcommand or flag; a changed
  default that alters existing behaviour; a changed output format someone
  could be parsing; a stored-data or key-location change requiring user action.
- **Added** — a new command, subcommand, flag, or provider.
- **Fixed** — wrong behaviour corrected, a crash removed, a failure made
  recoverable.
- **Internal** — tests, docs, ADRs, CI, refactors, dependency bumps with no
  user-visible effect.

Judge from the user's side of the CLI. Changes under `src/` are usually
user-facing; changes under `docs/`, `.github/`, `*.test.ts` and `Justfile`
usually are not — but verify rather than assume.

## 5. Compute the version

The project is pre-1.0, where the leading zero absorbs breakage:

| Highest bucket present | Bump | Example |
| --- | --- | --- |
| Breaking | minor | 0.2.3 → 0.3.0 |
| Added | minor | 0.2.3 → 0.3.0 |
| Fixed only | patch | 0.2.3 → 0.2.4 |
| Internal only | — | do not release; say so and stop |

Once the project reaches 1.0.0, switch to standard semver: breaking → major,
added → minor, fixed → patch.

State the computed version and the single change that drove it before
proceeding. If the only changes are internal, do not invent a release — report
that and ask whether to cut one anyway.

## 6. Write the notes

Group by the buckets above, most consequential first, omitting empty groups.
Write for someone who runs the CLI and has not read the code: name the command
or flag, say what changed, and say what to do differently. Skip internal churn
unless it explains a user-visible fix.

```markdown
### Breaking
- `infer keys rm` now requires the provider name. Pass one: `infer keys rm fal`.

### Added
- `infer fal models` searches available fal.ai models.

### Fixed
- `keys list` no longer fails on machines without an OS credential store
  (headless Linux, containers, WSL); it falls back to environment variables.

Update with `infer update`, or install with:
curl -fsSL https://raw.githubusercontent.com/jimzer/infersh/main/install.sh | sh
```

Show the notes and the version to the user before publishing.

## 7. Verify locally, then publish

```bash
just checkall
just bundle <version>            # e.g. just bundle 0.3.0
./dist/infer.js --version        # must print exactly that version
```

Keep `package.json` in step with the tag so the local `just bundle` default
does not drift, then publish:

```bash
# bump the version field in package.json to <version>
git add -A && git commit -m "Release v<version>" && git push origin main
gh release create "v<version>" -R jimzer/infersh \
  --title "v<version>" --notes-file <notes-file>
```

The tag is created by `gh release create` against the pushed HEAD, so push
first.

## 8. Verify the release actually shipped

```bash
RUN=$(gh run list -R jimzer/infersh --workflow=release --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" -R jimzer/infersh --exit-status
gh release view "v<version>" -R jimzer/infersh --json assets --jq '.assets[].name'
```

Then confirm the published artifact reports the right version, downloading the
**per-tag** URL:

```bash
curl -fsSL "https://github.com/jimzer/infersh/releases/download/v<version>/infer.js" -o /tmp/infer-check.js
grep -c '"<version>"' /tmp/infer-check.js
```

Never verify through `releases/latest/download/...`. That redirect is
CDN-cached and serves the *previous* release's asset for minutes after
publishing — it once made a no-op update report success (`docs/adrs/0004`).
`raw.githubusercontent.com` caches the same way, so a just-pushed `install.sh`
is not immediately what `curl | sh` fetches.

## 9. Dogfood the release through the official channel

Checking that the asset exists is not the same as checking that a user can
get it. Update this machine's own install the way a user would, then exercise
it:

```bash
command -v infer                 # expect ~/.local/bin/infer
infer --version                  # the version you are upgrading FROM
infer update                     # the official upgrade path
infer --version                  # must now report v<version>
infer --help
infer keys list
```

If `infer` is not installed, install it through the published installer first
and treat that as the smoke test instead:

```bash
curl -fsSL https://raw.githubusercontent.com/jimzer/infersh/main/install.sh | sh
```

Rules for this step:

- Run the **installed** binary. Never `just run`, never `./dist/infer.js` —
  those bypass the delivery path this step exists to test.
- Run it from **outside the repository**. Bun auto-loads `.env` from the
  working directory, so running inside the project makes every key resolve
  from the environment and hides the credential-store path (`docs/adrs/0002`).
- `infer update` must actually move the version. "Exited 0" proves nothing —
  a stale asset once made a no-op update report success (`docs/adrs/0004`).
  Compare `--version` before and after.
- If the installer was changed in this release, `raw.githubusercontent.com`
  may still serve the previous copy for a few minutes. Confirm which one ran
  from its output (the fixed installer prints the resolved tag,
  `Downloading infer vX.Y.Z...`) rather than grepping the script — a grep for
  an old URL also matches the comment explaining why it is not used.

A release is done only when the workflow is green, `infer.js` is attached, the
downloaded artifact reports the tagged version, and `infer update` on this
machine moved to it and still runs. Report the release URL, the version bump
reasoning, and the before/after versions from the dogfood step.

## If something fails

- Release workflow red → read `gh run view <id> --log-failed`, fix on `main`,
  then delete the release *and* its tag before retrying:
  `gh release delete v<version> -R jimzer/infersh --yes --cleanup-tag`.
- Version mismatch between tag and artifact → the workflow's verify step should
  have caught it; treat a mismatch that reaches an asset as a release bug and
  investigate before republishing.
- `infer update` reports success but `--version` is unchanged → the update path
  resolved a stale asset. This is a bug in `src/commands/update.ts`, not a
  transient glitch. Do not paper over it by reinstalling; fix and re-release.
