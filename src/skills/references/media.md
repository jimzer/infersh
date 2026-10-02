# infer media

Common ffmpeg jobs with the parameters that are easy to get wrong already
right. Needs `ffmpeg` and `ffprobe` on PATH, and no API key.

```bash
infer media info clip.mov                          # compact JSON: duration, size, video, audio
infer media web screen.mov                         # → screen.web.mp4, plays everywhere
infer media gif demo.mp4 --from 3 --to 7           # → demo.gif, own palette, not banded
infer media trim talk.mp4 --from 1:30 --to 2:15    # → talk.trim.mp4, frame-accurate
infer media frames clip.mp4                        # → clip.frames.jpg, 4x3 contact sheet
infer media audio meeting.mkv --for-transcription  # → meeting.16k.flac
```

For anything else — joining clips, overlays, subtitles, speed changes — call
`ffmpeg` directly.

## The contract

- Outputs go **beside the input** unless `-o` says otherwise, and stdout is the
  written path (one path per still for `frames --stills`). The input is never
  overwritten; an existing output is.
- `--json` reports what was actually written, **read back with ffprobe**:
  `output`, `duration`, `width`, `height`, `size` (bytes) — plus `codec`,
  `sampleRate`, `channels`, `copied` for `audio`, and `columns`, `rows` and
  every frame's `time` (and `path` for stills) for `frames`.
- `info` always prints JSON. `width`/`height` are as displayed (a rotated phone
  video reports portrait, with `rotation`). Fields ffprobe does not know are
  absent, not null; `video` or `audio` is absent when there is none. Cover art
  in an MP3 is not video.
- Times (`--from`, `--to`) take seconds (`12.5`) or clock times (`1:02`,
  `01:02:03.5`).
- A failure exits non-zero with ffmpeg's own last error lines. A failed run
  leaves no partial output where the real file should be.

## Look at a video before working on it

You cannot watch a video, but you can look at a contact sheet. **`infer media
frames` and then read the image** — 12 evenly spaced frames, each labelled
with its time:

```bash
infer media frames clip.mp4                       # what is in it, at a glance
infer media frames clip.mp4 --count 24 --columns 6
infer media frames clip.mp4 --stills --count 5    # full-size stills in clip.frames/
```

Use the labels to pick `--from`/`--to` for `trim` or `gif`. To look closer at
one section, `trim` it first and take a sheet of the trim. Each frame is a
fast seek, so long videos are fine.

## Choosing

- **Sharing a video, embedding it in a page, or a render that will not play
  somewhere**: `web`. It fixes the three usual reasons — 4:4:4 or 10-bit pixel
  format (screen recorders, ProRes, HDR phones), odd dimensions, and the index
  at the end of the file. `--max-width 1280` and `--crf 28` for a small
  preview.
- **An animation for a README, PR or chat**: `gif`, kept short (`--from/--to`,
  a few seconds) and narrow (`--width`, default 480). A muted `web --no-audio`
  MP4 is a fraction of a GIF's size and plays inline almost everywhere, so
  prefer it when the destination accepts video.
- **Cutting**: `trim` re-encodes so the first frame is exactly `--from`.
  `--copy` is instant and lossless but starts on the previous keyframe —
  measured on a test clip, a 2.5 s cut came out 4.07 s. Use `--copy` only for
  rough cuts of long recordings.
- **Audio**: `audio` copies the track when it can (AAC → `.m4a`, MP3 →
  `.mp3`, …), which is instant and lossless. `-o x.mp3` re-encodes to the
  format you named. `--for-transcription` writes 16 kHz mono FLAC for any
  speech-to-text API; `infer groq transcribe` already does that conversion
  itself, so do not pre-convert for it.

## Facts that change what you do

- Only the **first** video and audio streams are used by `web` and `audio`
  (and by `groq transcribe`). `info` reports `streams.audio` — when it is more
  than 1, the track you want may not be the first; use ffmpeg with
  `-map 0:a:N`.
- `trim` to `.mp4`/`.mov` re-encodes at CRF 18 (visually lossless); other
  containers use ffmpeg's own codecs for them. Subtitles are dropped from MP4
  and MOV cuts.
- `web` and `trim` crop an odd width or height by one pixel: 641x361 becomes
  640x360.
