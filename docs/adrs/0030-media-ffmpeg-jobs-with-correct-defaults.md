# 30. `infer media`: ffmpeg jobs with the defaults decided once

- Status: accepted
- Date: 2026-10-02

## Context

Agents reach for ffmpeg constantly — to share a render, make a GIF for a PR,
cut a clip, pull audio for transcription — and get the same parameters wrong
each time: an MP4 that will not play in Safari, a banded GIF, a cut that starts
a second early, ffprobe output parsed by hand. They also cannot watch a video
at all, only look at images.

## Decision

`infer media` with six subcommands — `info`, `web`, `gif`, `trim`, `frames`,
`audio` — each a fixed ffmpeg recipe with a few flags. Everything that shapes
an invocation is a pure function in `src/media.ts`, tested without ffmpeg; a
`Media` service (layer capturing `FileSystem` and `ChildProcessSpawner`, methods
as `Effect.fn`) runs them through `stage.ts`'s `run`. The command provides its
own layer with `Command.provide`, so `main.ts` only lists the command. Joining
clips is left out; for anything unusual, the help says to call ffmpeg.

### The defaults, and why

Every job runs with `-hide_banner -nostdin -v error -y`: `-nostdin` because an
ffmpeg child reading stdin swallows keystrokes and can stall; `-v error` so
stderr holds only the reason a run failed, and its last five lines are the
error message, as `groq` already did.

**`info`** decodes `ffprobe -print_format json -show_format -show_streams` with
Schema. ffprobe prints numbers as strings and unknowns as `N/A`, so every field
is `lenient` (ADR 24): an `N/A` duration drops that field, not the probe.
Dimensions are reported **as displayed** — a phone video stored 1920x1080 with
a −90° display matrix reports 1080x1920 and `rotation: 270` — because every
later step (ffmpeg autorotates before filters) works in displayed pixels.
Streams flagged `attached_pic` are cover art, not video: an MP3 with artwork
otherwise "has video". It always prints JSON.

**`web`** — H.264 + AAC MP4:

- `-pix_fmt yuv420p`. libx264 otherwise keeps the source's format, so a 4:4:4
  screen recording or a 10-bit HDR clip produces High 4:4:4 / High 10 H.264,
  which Safari, iOS and hardware decoders refuse. This is the most common
  "the MP4 won't play" cause.
- **Even dimensions**, which yuv420p H.264 requires. An odd side is
  **cropped** by one pixel (`crop=640:360:0:0`), not scaled: a one-pixel
  rescale resamples and softens the whole frame. With `--max-width` the frame
  is scaled (lanczos) to even sides computed in TypeScript from the probe, so
  no filter expression needs escaping and the result is testable.
- `-movflags +faststart`: `moov` before `mdat`, so playback starts before the
  download finishes. Verified by reading the atom order:
  `ftyp moov free mdat` against the source's `ftyp wide mdat moov`.
- CRF 23 / preset medium (x264's own defaults, a good size/quality point), AAC
  128k, **downmixed to stereo only when the source has more than two channels**
  (5.1 AAC is not decoded everywhere; mono stays mono).
- Only `0:v:0` and `0:a:0?` — the first of each; the `?` makes audio optional,
  so a silent source needs no special case.

**`gif`** — two passes through a scoped temp directory: `palettegen` computes
256 colours from this clip, `paletteuse` maps frames onto them. Both passes use
the same `fps,scale` chain and the same seek, so the palette is built from
exactly the frames drawn. `stats_mode=diff` weighs moving parts;
`dither=sierra2_4a` (error diffusion) with `diff_mode=rectangle` (only redraw
what changed); lanczos scaling; `-loop 0`. Defaults: 15 fps, 480 px wide, never
upscaled. Two passes rather than one `split` graph because a single graph must
hold every frame in memory until the palette exists.

Measured on a 2 s 480x270 test-pattern clip, first frame against the source:
palette GIF **37.9 dB PSNR, naive `ffmpeg -i in out.gif` 29.2 dB**, with the
naive one visibly speckled on flat colour. The palette GIF was *larger* (500 KB
vs 429 KB) — dithering costs bytes; bayer dithering was 468 KB at 36.4 dB, no
dithering 457 KB. Quality was chosen; size is controlled by `--fps`, `--width`
and length, which the help says.

**`trim`** re-encodes by default, with `-ss` *before* `-i` (fast input seek,
then decode forward to the exact frame) and `-t` as a duration. Measured: a
1.5–4 s cut is 2.500 s and 75 frames at 30 fps, and its first frame is the
source's frame 45 (the burnt-in testsrc2 clock reads 00:00:01.500). MP4/MOV
outputs get the `web` encode at **CRF 18** — visually lossless, because a cut
is an edit, not the delivery. Other containers get ffmpeg's codecs for them.
`--copy` is offered for rough cuts: `-c copy -avoid_negative_ts make_zero` is
instant and lossless, but starts on the preceding keyframe — the same 2.5 s
cut came out **4.07 s** (122 frames). Subtitles are dropped from MP4/MOV
re-encodes (most formats cannot go into MP4 without conversion).

**`frames`** — N times at the *middle* of N equal slices (never frame 0 or
the last frame, which are often black), each extracted by its own fast-seek
ffmpeg run, four at a time (`Effect.forEach` with `concurrency: 4`), so a long
video is never decoded end to end. A contact sheet tiles them with
`tile=CxR` (a short last row is padded) from a scoped temp directory; the time
is burnt into each frame with `drawtext` when this ffmpeg has it (it needs
libfreetype — checked once via `ffmpeg -filters`, with a note when absent).
Defaults: 12 frames, 4 columns, 320 px tiles, giving a ~1300 px JPEG an agent
can read in one image. `--stills` writes full-size `frame-001.jpg`… instead.

**`audio`** copies the first track when the output's container holds its codec
as-is (AAC→`.m4a`, MP3→`.mp3`, Opus→`.opus`, PCM→`.wav`…), which is instant and
lossless; the default output uses the codec's own container, so the default is
always a copy. Another extension re-encodes to it. `--for-transcription`
**reuses `groq.ts`'s `ffmpegArgs`** (ADR 9's 16 kHz mono FLAC), so the two
cannot drift.

### Outputs, reports and failures

- Default outputs go **beside the input**: `clip.web.mp4`, `clip.gif`,
  `clip.trim.<ext>`, `clip.frames.jpg` / `clip.frames/`, `clip.m4a`,
  `clip.16k.flac`. An untagged name that would equal the input becomes
  `clip.out.<ext>`; an explicit `-o` equal to the input is refused.
- Each encode writes to a hidden `.<name>.partial-<pid><ext>` **beside** the
  output (an `acquireRelease`d path, so the rename never crosses filesystems)
  and is renamed into place only on success. The real path never holds a
  truncated file; ffmpeg errors are rewritten to name the requested path.
- `--json` reports what was written, **probed back** rather than predicted:
  `output, duration, width, height, size`, plus codec details for `audio` and
  the grid and frame times for `frames` (no duration — ffprobe calls a JPEG
  0.04 s long).
- A missing input is checked before ffprobe runs ("No such file"). A file
  ffprobe cannot read fails with its own words ("moov atom not found …
  Invalid data found when processing input"). A spawn that fails with
  `NotFound` becomes "ffprobe was not found on PATH" with install commands.

## Consequences

**Found on the way: `groq transcribe` failed on any file with two audio
tracks.** ADR 9's `-map 0:a` maps *every* audio stream, and FLAC holds exactly
one: `Invalid audio stream. Exactly one FLAC audio stream is required.` — so a
screen recording with mic and system audio could not be transcribed. It is now
`-map 0:a:0`, which is what the docs already claimed ("only the first audio
track is transcribed").

**Ctrl-C still leaves the hidden partial file.** `main.ts` runs the CLI with
`Effect.runPromise`, which does not turn SIGINT into fiber interruption, so
Bun exits with 130 before any finalizer runs. Simulated with SIGINT to the
process group mid-encode: `.int.partial-<pid>.mp4` remained (the requested
output did not). Failures and errors clean up; signals do not — and the same
applies to every scoped temp directory in the CLI (ADR 23). Fixing it belongs
in `main.ts` (interrupt the main fiber on SIGINT/SIGTERM), for all commands at
once.

**testsrc2 rounds odd sizes.** `testsrc2=size=641x361` produces 640x360, and so
does cropping a yuv420p frame to odd sides; odd-dimension fixtures need
`format=yuv444p` before the crop.

**Seeking past the end is silent.** `ffmpeg -ss <beyond> … -frames:v 1 x.png`
exits 0 and writes nothing, so `frames` checks that each still exists.
