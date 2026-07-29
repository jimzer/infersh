# 9. Preprocess audio with ffmpeg by default

- Status: accepted
- Date: 2026-07-29

## Context

Groq's speech-to-text endpoints cap direct uploads at 25 MB and accept a fixed
list of container formats. Groq's own documentation recommends converting audio
to 16 kHz mono FLAC before upload, because that is exactly what the service
downsamples to server-side anyway.

That leaves a choice: make the conversion opt-in, or do it by default.

## Decision

`infer groq transcribe` runs the documented ffmpeg pass on every local file
before uploading:

```
ffmpeg -i <input> -ar 16000 -ac 1 -map 0:a -c:a flac -y <output>
```

`--no-optimize` skips it. `--url` is never preprocessed, since the file is
never fetched locally.

## Consequences

Converting by default costs nothing in accuracy — the service resamples to
16 kHz mono regardless — and buys two things. It roughly halves the upload
(measured: a 431 KB AIFF became a 178 KB FLAC, 59% smaller), which decides
whether a long recording fits under 25 MB at all. And it accepts *anything
ffmpeg can read*, not just Groq's nine container formats.

That second point is the bigger win, and it is easy to miss. A `.aiff`
recording — what macOS `say` and QuickTime produce — is not on Groq's list. It
transcribes fine with the default path and fails with
`--no-optimize`: `file must be one of the following types: [flac mp3 ...]`. So
`--no-optimize` warns first when the extension is not one Groq accepts,
explaining what the flag just skipped rather than letting the API produce a
confusing rejection.

A missing ffmpeg is a warning, not an error: the file may already be small and
in an accepted format, so the run proceeds with the original rather than
failing on a tool the user may not need.

Uploads are renamed to the basename before sending, both because the extension
is what drives Groq's format detection and to keep the local path off the wire.

Testing against the live API surfaced one documentation gap: Groq's own
rejection message lists `opus` as accepted, though the supported-formats table
in the docs omits it.
