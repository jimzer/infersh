# 34. `human download` serves the named files by position, and counts only whole downloads

- Status: accepted
- Date: 2026-10-05

## Context

`human upload` (ADR 33) lets the human send the agent files. The reverse was
missing: an agent that rendered a video or wrote a report had no way to put it
on the human's phone except telling them a path. The files can be large (a
multi-GB render), the human may be on a phone over `--share`, and the agent
needs to know which files actually reached them.

## Decision

**A built-in `download` page, and file and zip endpoints in the page server
that stream from disk.**

- **Only the files on the command line, by position.** `GET /api/file/:index`
  takes digits only; anything else, or an index past the end, is 404. There is
  no path in any URL, so there is nothing to traverse. The CLI checks every
  file before serving: a missing file, a folder (refused with a hint to pass
  `dir/*`, rather than expanded, so what is offered is exactly what was named)
  or an unreadable file fails the command. The same path given twice is
  offered once.
- **The token is in the query string for these.** An `<img>`, a `<video>` and
  a download link cannot send the `x-infer-token` header, so the server takes
  `?token=` as well. A wrong or missing token is 403, as everywhere else.
- **Range requests, from first principles.** One range per request
  (`a-b`, `a-`, `-n`); a range starting past the end is 416 with
  `Content-Range: bytes */size`; a malformed header or several ranges are
  ignored and the whole file is sent, which RFC 9110 allows. `ETag` and
  `Last-Modified` come from the file's size and mtime, and `If-Range` that
  matches neither sends the whole file, so a resume never splices two
  versions. `HEAD` is answered.
- **Preview and download are the same file, served two ways.** Without
  `download=1` a previewable type (image, video, audio, PDF) is `inline` and
  goes out as a `Bun.file` slice (sendfile, real `Content-Length`). With it,
  the response is `attachment`, carries the name as plain ASCII in
  `filename` and exactly in `filename*=UTF-8''…` (RFC 6266/5987), and is
  metered. Every file response has `X-Content-Type-Options: nosniff`, and all
  but PDFs `Content-Security-Policy: sandbox`: the page's origin holds the
  token, and an SVG opened there could otherwise run script against it.
  (Chrome will not show a sandboxed PDF, and its viewer is out of process.)
- **Downloaded means every byte was sent to a download.** The metered stream
  records each chunk as sent when the server pulls the next one, so a chunk
  counts once written out, not when read. Spans are merged per file, so a
  download cut at 100 MB and resumed with `curl -C -` counts once the second
  request finishes. A preview never counts, even one that read the whole
  video: watching is not saving. A Download all counts for every file in it,
  but only once the archive's last byte went, since a cut-off zip is useless.
- **Download all is a stored ZIP, streamed** (`src/ui-zip.ts`, no packages,
  since Bun has no zip writer). Stored, not deflated: the files worth handing
  over are mostly media, already compressed, and stored entries make the
  archive's size known before the first byte. Each entry's CRC-32
  (`node:zlib`'s, incremental, about 5 GB/s) is computed as it streams and
  written in a data descriptor. ZIP64 fields appear only for an entry past
  4 GB or one starting past 4 GB; names are UTF-8 with bit 11 set, reduced to
  one path segment, and deduped without case (`a.txt`, `a (2).txt`) so they
  do not collide when unzipped on macOS or Windows. The archive is named after
  the files' folder when they share one (`renders.zip`), else `files.zip`.
  It cannot resume (`Accept-Ranges: none`).
- **Done waits for downloads in flight.** Pressing Done while a download is
  running would otherwise stop the server under it. The answer is sent once
  no download is active, bounded by what is left of `--timeout`. Previews are
  not waited for: a paused video can hold a connection open indefinitely.
  There is no Cancel: there is nothing to decline.
- **Output: the downloaded paths on stdout, however it ended.** One per line,
  in command-line order, with `n of m files downloaded` on stderr. Unlike
  upload, a timeout still lists them: a file the human downloaded is on their
  device whether or not they pressed Done. `--json` is the usual envelope with
  `payload: {downloaded: [{path, name, size}]}` and status `done` or
  `timeout`. The page polls `/api/downloads` to mark files as downloaded.

## Consequences

**`Bun.serve` drops a `Content-Length` set on a JavaScript `ReadableStream`
body** and sends it chunked — any size, `Headers` object or not, `direct` and
`bytes` streams alike, while a `Bun.file(...).stream()` keeps it. The metered
download and the zip are therefore chunked: the browser shows bytes received
with no total. The page shows each size, and the range, `ETag` and
`Last-Modified` headers that resuming needs are all there. Keeping the length
would mean serving the native stream, which gives no way to learn the
download finished; knowing what reached the human was worth more.

**`curl -OJ` saves `résumé été.txt` as `resume ete.txt`**: curl reads only
`filename`, never `filename*`. Browsers use `filename*`.

**macOS `unzip -Z1` mangles UTF-8 names in its listing**, while extracting
them correctly; the unit test checks the flag and the bytes instead.

Verified with unit tests (range parsing, the filename encoding, span merging,
the zip writer checked by `unzip -t` in both ZIP64 modes, download tracking
including cut-off downloads and zips) and end to end. With Playwright at
390 px: an image, a PDF, a 535 MB H.264 video, an audio file and two
`résumé été.txt` from different folders. The image decoded, the video loaded
its metadata and seeked to 7:30 through range requests starting past 0, the
audio loaded, and the PDF opened inline in a new tab; none of that counted as
downloaded. Each Download button saved a byte-identical file (sha1) under its
UTF-8 name; Download all (535 MB, under a second on loopback) passed
`unzip -t`, every entry matched its source, and the duplicate became
`résumé été (2).txt`. Done then printed all six. Pressing Done while the
video was still downloading printed `Waiting for 1 download to finish…`, the
download completed intact, and stdout listed the two files. With curl:
`-r 0-99`, `-r 1000-`, `-r -500` gave 206 with the right bytes and
`Content-Range`; past the end gave 416; a wrong or missing token 403; index 6,
99, -1 and `../` paths 404; a 100 MB partial download resumed with `curl -C -`
matched and counted. A 4.5 GB file zipped to a ZIP64 archive (4.7 GB, 5.7 s)
that `unzip -t` passed. Streaming the zip and the video at once kept the page
server's resident memory under 105 MB. SIGINT to the CLI, SIGINT to its
process group and SIGTERM, each mid-download, exited 130 with no page server
left; a timeout mid-download exited 0 with status `timeout`, listing the file
that had finished.
