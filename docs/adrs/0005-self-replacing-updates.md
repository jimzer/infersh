# 5. Self-replacing updates

- Status: accepted
- Date: 2026-07-29

## Context

`infer update` has to overwrite the very file that is currently executing,
without leaving a half-written binary behind if the download fails.

## Decision

Download to a temp file **in the same directory as the target**, `chmod 0755`,
then `rename` over the target. Resolve the target with
`realpathSync(Bun.main)`. Delete the temp file on any failure.

## Consequences

The temp file must share a directory with the target: `rename` is only atomic
within a filesystem, so writing to `/tmp` and moving across devices would
degrade to a copy and could be observed half-written. Keeping it beside the
target also means a failed download cannot leave debris in a directory the
user did not expect.

Replacing a running script is safe — the kernel keeps the live process on the
old inode until it exits. Verified by checking the inode changes while the
process that triggered it completes normally.

`realpathSync` resolves symlinks, so updating through a symlinked bin
directory rewrites the real bundle and leaves the symlink intact. Without it,
`rename` would replace the link itself with a regular file.

Running from source is refused. `Bun.main` ending in `.ts` means a checkout,
and overwriting `src/main.ts` with a minified bundle would destroy work.
`--force` does not override this; it only forces a reinstall of an
already-current version.
