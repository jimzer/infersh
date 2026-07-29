# Remotion, as used by `infer render video`

Everything here applies inside a composition rendered by
`infer render video`. Read [render.md](render.md) first for the CLI contract.

Most Remotion material online assumes a Remotion *project* — `npx remotion
studio`, a `remotion.config.ts`, `<Composition>` registration, Lambda
deployment. **None of that applies.** `infer` stages and registers the
composition for you, so ignore project setup, the Studio and the CLI entirely
and read only the parts about writing compositions.

Facts below are distilled from Remotion's own documentation and agent skills,
rewritten for this flow. When in doubt, look it up rather than trusting memory —
Remotion moves quickly.

## Looking up current documentation

Search their docs index:

```
POST https://plsduol1ca-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=3e42dbd4f895fe93ff5cf40d860c4a85&x-algolia-application-id=PLSDUOL1CA
Content-Type: application/x-www-form-urlencoded

{"requests":[{"query":"<query>","indexName":"remotion",
 "params":"attributesToRetrieve=[\\"hierarchy.lvl0\\",\\"hierarchy.lvl1\\",\\"url\\"]&hitsPerPage=10"}]}
```

Each hit has a `url`. Then **append `.md` to any docs URL** to get the Markdown
source instead of the HTML page — far fewer tokens:

```
https://www.remotion.dev/docs/sequence.md
https://www.remotion.dev/docs/use-current-frame.md
```

Prefer this over recalling an API signature. If the search key ever stops
working, fetch the `.md` URL directly — the suffix trick is independent of it.

## The rule that catches everyone

**CSS `transition` and `animation` do not work.** Neither do Tailwind's
animation classes. Every frame is rendered independently by seeking to it, so
anything relying on elapsed wall-clock time renders as a single static state.

Animate from the frame number instead:

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export default () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: "#000", justifyContent: "center" }}>
      <div
        style={{
          opacity: interpolate(frame, [0, fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        Hello
      </div>
    </AbsoluteFill>
  );
};
```

If you are given a composition using CSS animations, **refactor them** rather
than trying to make them work.

## Interpolating well

- **Always clamp both ends** — `extrapolateLeft` and `extrapolateRight` set to
  `"clamp"`. Without them values keep travelling past the range.
- Express durations in terms of `fps` from `useVideoConfig()` rather than
  hard-coding frame counts, so the composition survives an `--fps` change.
- `Easing.bezier(...)` and `spring()` for anything that should not feel linear.
- Keep the `interpolate()` call **inline in the `style` prop** — it reads as a
  keyframe and stays easy to adjust.
- Prefer the individual CSS properties `scale`, `translate` and `rotate` over a
  combined `transform` string; they interpolate independently and are far easier
  to edit.

## Timing with Sequence

```tsx
import { Sequence } from "remotion";

<Sequence from={30} durationInFrames={60}>   {/* second 1 to second 3 at 30fps */}
  <Title />
</Sequence>
```

Inside a `Sequence`, `useCurrentFrame()` restarts at 0 — so children animate
relative to their own start, not the timeline. That is what makes scenes
reusable.

- `from` shifts when it appears, `durationInFrames` how long it stays.
- `trimBefore` skips into the child's own timeline instead of delaying it.
- `layout="absolute-fill"` makes the Sequence behave like `AbsoluteFill`;
  `layout="none"` renders no wrapper element at all, when the wrapper would
  break your layout.
- `<Loop durationInFrames={n}>` repeats its children.

## Media

Video and audio come from `@remotion/media`; images and animated images from
`remotion` itself. Nothing needs installing — `infer` resolves whatever the
composition imports.

```tsx
import { Audio, Video } from "@remotion/media";
import { AnimatedImage, CanvasImage, staticFile } from "remotion";

<Video src={staticFile("clip.mp4")} style={{ opacity: 0.5 }} />
<Audio src={staticFile("music.mp3")} />
<CanvasImage src={staticFile("logo.png")} style={{ width: 100 }} />
<AnimatedImage src={staticFile("cat.gif")} />
<Video src="https://example.com/remote.mp4" />          {/* remote URLs work directly */}
```

**`staticFile()` resolves against the directory passed to `--assets`.** That is
the one place video differs from `render image`/`render pdf`, which use plain
relative URLs. A remote URL can be passed straight through without `--assets`.

For a plain `<img>` prefer `Img` from `remotion` over a raw tag — it makes the
renderer wait for the image instead of capturing a blank frame.

Needing a media file's real duration or dimensions to size a composition is a
common case; look up `@remotion/media-parser` rather than guessing.

## Working with `infer`

- Frame size and length come from `export const config` on the composition, and
  any flag overrides it. See [render.md](render.md).
- **Iterate with `--frame`**, which renders one frame and skips encoding
  entirely. Check frame 0, the middle and the last before encoding anything.
- Fonts are not automatic. Use `@remotion/google-fonts`, or inject a `<link>`
  and wait for it — a missing font silently falls back and shifts your layout.
- Randomness must be deterministic: use `random()` from `remotion` with a fixed
  seed, never `Math.random()`, or frames rendered in parallel will disagree.
