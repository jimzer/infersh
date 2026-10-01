# 25. Video: pinned Remotion, size from props, batched stills

- Status: accepted
- Date: 2026-10-02

## Context

A review of `render video` against ADR 13 found five things worth changing.
The overall design held: isolated renders, Remotion kept out of this repo, and
configuration passed as data rather than generated code.

## Decision

1. **Pin Remotion.** `REMOTION_VERSION` and `REACT_VERSION` in
   `render-video-source.ts`; `videoDeps` applies the pin to every
   `remotion` / `@remotion/*` package, including any the composition imports.
2. **Stop hardcoding `gl: "angle"`.** Unset leaves Remotion's default; `--gl`
   chooses a backend.
3. **Pass `calculateMetadata` through.** The staged root layers defaults, the
   composition's `config`, its `calculateMetadata`, then explicit flags.
4. **`--frame` takes a list.** `--frame 0,45,89` renders several stills from one
   bundle and one browser.
5. **The Remotion files are real files.** `src/remotion/{Root.jsx,index.js,
   worker.js}`, embedded as text as before.

## Consequences

**Unpinned meant unpredictable, and could mean broken.** Remotion shipped eight
releases between 2026-09-15 and 2026-10-01. Every render installed whatever was
newest, so the same composition could render differently on consecutive days.
Worse, Remotion refuses to run with mixed versions, so a composition importing
`@remotion/transitions` broke whenever a release landed between installs.
Verified: a composition printing Remotion's `VERSION` and importing
`@remotion/transitions` renders `4.0.532` with both loaded. Pinning is about
correctness, not speed — a warm install measured 0.1 s pinned or not.

**`angle` was wrong without a GPU.** Remotion's docs say not to use it on a
machine with no GPU, where `swangle` is recommended and is Remotion's own
default on Lambda and Cloud Run. Linux servers and CI are exactly that case.

**Props can size the video.** A three-slide composition with
`calculateMetadata` returning `slides.length * 30` encoded to exactly 90 frames,
3.000 s by ffprobe; `--duration 45` overrode it, and a frame past the new end was
reported with the real length, before anything rendered.

**Several stills cost about one.** Three frames in one call took 3.2 s, the same
as one: bundling and starting the worker dominate, and the browser is now opened
once and shared by `selectComposition` and every `renderStill`. Several frames
write beside `--output`, numbered by frame.

**The worker is JavaScript, not TypeScript, on purpose.** It and the root
import Remotion, which is not installed here, so `tsc` cannot check them —
and listing them in `exclude` does not help, because `tsc` still loads any file
the program imports, text imports included. As JavaScript, with `allowJs` on
and `checkJs` off, `tsc` reports nothing for them while Biome lints and formats
them like everything else. Two consequences: the staged `package.json` is
`"type": "module"`, so relative imports in these files need their extension
(`./Root.jsx`, `./composition.tsx`); and a bad frame is now written as a
message, not thrown, so it does not arrive with a stack trace.
