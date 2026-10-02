# 33. `human upload` streams each file to disk as it is added

- Status: accepted
- Date: 2026-10-02

## Context

Every `infer human` page sends something back to the agent. Until now that
was always JSON: a pick, a verdict, some text. Some answers are files, though:
a photo taken on a phone, a signed PDF, a screen recording. An agent had no
way to get one from the human except asking them to copy it somewhere by hand.

A page could already read a file and `infer.submit` it as base64. That
inflates it by a third, and the page server would hold it in memory, then
the CLI's stdout reader, then the JSON parser. A one-gigabyte video would need
several gigabytes of memory. Nothing would be on disk until the end, so one
failed request would lose the whole upload.

## Decision

**A built-in `upload` page, and an upload endpoint in the page server that
streams each file to disk as it is added.**

- **One request per file, the raw file as the body.** The name and type go in
  headers (`x-infer-name`, URI-encoded, and `x-infer-type`), and the run's
  token goes in `x-infer-token`, the same check as `/api/submit`. A raw body
  needs no multipart parser, and the server writes each chunk before reading
  the next, so its memory stays flat. The page sends each file with
  `XMLHttpRequest`, which reports upload progress (`fetch` does not), with
  three at a time.
- **Uploading starts when a file is added, not when Send is pressed.** Most
  files are done by the time the human has written a note. Send is disabled
  until at least one file is done and none is still in flight. The page then
  sends the server's ids for the files to keep, and the note. The server turns
  those ids into `{path, name, size, type}` and deletes everything else.
- **A file only gets its real name once it is complete.** It streams into a
  hidden `.infer-upload-<uuid>.part` in the target folder. When it is
  finished, it is hard-linked to its name and the partial is unlinked. A link
  fails with `EEXIST` rather than overwrite, so names are deduplicated
  (`report (2).pdf`) with no race against files that appear in the meantime.
  On a filesystem without hard links it falls back to a rename after an
  existence check.
- **Nothing a run did not finish is left behind.** Removing a file deletes it.
  Cancel, timeout, SIGINT, SIGTERM and the CLI vanishing (stdin closing, which
  covers kill -9) all delete every upload and every partial. Only a submitted
  answer keeps files, and only the ones it names. The CLI creates the folder
  with `Effect.acquireRelease`. If the run ends with the folder empty, the
  folder and any parents the run created are removed, so a question nobody
  answered leaves no empty `uploads/…` behind.
- **Names are sanitized server-side.** Only the last path segment is kept,
  control and reserved characters become `_`, leading dots are stripped (no
  hidden files, no `..`), and names are cut to 200 bytes with the extension
  kept. The JSON's `name` is still the name as sent, for the agent's context.
- **Limits are enforced by the server, as well as by the page.** `--accept`
  matches extensions against the name and MIME types (`image/*` included)
  against the browser's type, or against the type Bun infers from the
  extension when the browser gives none. `--max-size` is checked against
  `Content-Length` before reading, and again as bytes arrive, which covers a
  chunked body. `--max-files` counts files currently held. The page checks
  the same rules first, so a refused file says why without being sent.
- **Output: the paths on stdout, one per line; the note on stderr.** A note
  can contain anything, newlines included, so putting it on stdout would break
  line-per-path parsing. `--json` prints the usual `{status, payload, ...}`
  shape with `payload: {files, note?}`. Status stays in it, so that `timeout`
  still cannot be mistaken for an answer.

The receiving code and its rules live in `src/ui-upload.ts`. That file is
embedded as text and written beside `ui-child.ts`, which imports it, so it may
import only Node built-ins: the child has no packages. The CLI imports only
its types. Parsing the flags (`parseAccept`, `parseSize`) lives in
`human/presets.ts`.

## Consequences

**`Bun.serve` refuses request bodies over 128 MB by default**
(`maxRequestBodySize`). Uploading a 250 MB file was the first thing that
would have failed. The page server lifts that limit, and `--max-size` is the
limit that applies.

**Bun's bundler cannot take one file both as text and as a module.**
Importing `ui-upload.ts` with `{ type: "text" }` and also normally fails the
bundle with `No matching export ... for import "default"`, even through a
different relative specifier. `bun test` and `bun run` accept it, so only
`just bundle` catches it. Hence the split above: a type-only import is erased
and is fine.

**`text=Send` in Playwright matched the page title** when the prompt
contained "Send". The checks use `getByRole("button", { name, exact })`.

**A `Request` built in a test has no `Content-Length`**, so the up-front size
check needs the header set explicitly. The streaming check is covered
separately, with a body that has no length.

Verified end to end with Playwright on the real page at phone width. Five
files were added, including 250 MB and 1 GB random files, and one was removed
before Send. With a note, Send printed the four paths in the order they were
added: a clashing `report.pdf` was saved as `report (2).pdf` and the existing
file was untouched. Every shasum matched the source. The 1 GB file uploaded in
about 4 s on loopback, and the page server's resident memory peaked at 91 MB.
In the page, a wrong type, an oversize file and a third file over
`--max-files 2` were each refused with a clear message. Posted straight to the
server, bypassing the page, a wrong type (415), an oversize file (413), a
chunked body that passed the limit, and a wrong token (403) were refused too.
A `../../` name was saved inside the folder. The unit tests cover the server's
file count. Cancel and timeout left no files and no
folder. SIGINT to the CLI alone, SIGINT to the process group (a terminal's
Ctrl-C) and SIGTERM, each sent while the 1 GB file was part-way through,
exited 130 and left no `.part` file, no folder and no page server running. An
uncatchable kill leaves the files cleaned up by the child, but the empty folder
stays, since the CLI's own finalizer cannot run.
