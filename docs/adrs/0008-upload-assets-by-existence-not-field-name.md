# 8. Upload assets by existence, not by field name

- Status: accepted
- Date: 2026-07-29

## Context

fal models take assets as CDN URLs, so a local file has to be uploaded before
it can be referenced. Making the user upload separately and paste URLs back in
is the very friction the CLI exists to remove.

The previous implementation guessed which fields held assets from their
*names* — anything matching `url|image|video|audio|file`.

## Decision

Walk the entire `--input` payload, at any depth, and treat a string as an
asset when it **is a path to a file that exists on disk**. Upload those,
substitute the CDN URLs, and print the mapping to stderr.

Strings that are already addressable (`http:`, `https:`, `data:`, `file:`,
`ftp:`), empty strings, strings over 4096 characters and strings containing
newlines or NULs are never stat-ed.

## Consequences

Existence is a far better signal than a field name. The name heuristic missed
assets in fields called `reference`, `mask` or `init`, and fired on fields that
merely contained "file" in the name while holding ordinary text. A model with
an oddly named asset field now works with no code change.

The pre-filter matters: without it a prompt would be stat-ed as a filename on
every run. It is a cheap guard, and the existence check does the real work — a
prompt like `"a cat"` simply is not a file.

The risk is the inverse: a prompt that happens to match a file in the working
directory would be uploaded and replaced. In practice prompts are prose and
paths are not, and the mapping is printed for every upload so a surprise
substitution is visible rather than silent.

Uploads are renamed to the file's **basename** before being sent. `Bun.file()`
carries the full path as the blob's name and fal bakes that name into the
public CDN URL, so uploading `/Users/me/secret-project/a.png` would otherwise
publish the whole directory structure in a shareable link.

Upload progress goes to stderr and only the model's output goes to stdout, so
`infer fal run … | jq` works.

## Output assets

The reverse direction uses the mirror-image rule. fal returns files as objects
carrying a `url` next to `file_name` and `content_type`, whatever the
surrounding field is called (`images`, `video`, `audio`), so `--output` matches
on that *shape* rather than on a list of field names.

`--output` writes those assets and prints the paths instead of the JSON: the
target verbatim for a single asset, numbered `out.png`, `out-2.png` when a
model returns several, and the model's own filenames when the target is an
existing directory or ends in `/`. The raw result is still written to stderr,
because the seed and timings are unrecoverable once a run has been billed.

A model that returns no downloadable asset fails loudly rather than writing
nothing, since silently producing no files would look like success.
