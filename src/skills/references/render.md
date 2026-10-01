# infer render

Turn a TSX component into an image, a PDF, a portable HTML page or a video.

```bash
infer render image  card.tsx      -o card.png
infer render pdf    invoice.tsx   -o invoice.pdf
infer render html   dashboard.tsx -o dashboard.html
infer render video  intro.tsx     -o intro.mp4
```

The same composition and `--props` work for image, pdf and html.

Run `infer render <sub> --help` for flags.

## The composition contract

A composition is a `.tsx` file with a **default export** that is a component:

```tsx
export default ({ title = "Untitled" }: { title?: string }) => (
  <div style={{ padding: 48, fontFamily: "system-ui" }}>
    <h1>{title}</h1>
  </div>
);
```

- **Props arrive as the first argument**, from `--props`. Give every prop a
  default so the composition renders standalone.
- It may import **other `.tsx` files** by relative path — they are inlined
  automatically, at any depth.
- It may import **images, fonts and other files** (`import logo from "./logo.png"`).
  They are embedded, so this works in every renderer with no `--assets`.
- It may import **any npm package**. Nothing needs installing; packages are
  fetched into Bun's cache on first use and reused. Charts, icons, date
  libraries all work.
- Renders happen **in isolation** from whatever directory the file lives in, so
  nothing leaks in from a surrounding project.
- Read the composition from stdin with `-` instead of a path. An inline
  composition cannot use relative imports, because there is no directory to
  resolve them against.

## Props

```bash
infer render image card.tsx --props '{"title":"Hello"}'
infer render image card.tsx --props ./data.json
```

Inline JSON or a path to a `.json` file. Both go straight to the component.

## image

Sizing is the thing to get right:

- `--width` sets the viewport width (default 1280).
- **Omit `--height` and the image hugs the content.** The height is measured
  from the rendered body, so a card comes out exactly its own height rather
  than padded to a viewport. Set `--height` only when you want a fixed frame,
  such as a 1200×630 OG image.
- `--scale 2` renders at retina resolution, doubling the pixel dimensions.
- `--transparent` for a transparent background (png/webp only).
- The output extension picks the format: `.png`, `.jpg`, `.webp`.

## pdf

- `--format a4|letter|…`, or `--width 210mm --height 297mm` for a custom page
  (both must be given together).
- `--margin 1cm` applies to all four sides. Default is none.
- Backgrounds are always printed, so a screen-styled composition looks the same
  on paper.

## html

One self-contained `.html` file that **stays interactive**: the composition is
bundled with React into an inline script and mounted in the browser, so
`useState`, click handlers, tabs, filters and charts that respond to the mouse
all work — none of which survive as a PNG or PDF.

Everything is inside the file: the script, Tailwind, CSS the composition
imports, imported images and fonts, and files under `--assets` that it names.
It opens offline, from any folder, with nothing beside it — so it can be
emailed, attached or archived. Only already-absolute URLs (`https://…`) are
left for the browser to fetch.

- **Pick html over image/pdf** when the reader should interact: explore data,
  switch views, expand details. Pick image/pdf for something fixed to look at
  or print.
- **Pick html over `infer ui`** when the result is a file to keep or hand to
  someone. `ui` is for asking the user a question and getting an answer back;
  it needs the CLI running. html needs nothing once written.
- Expect a few hundred KB before any assets — React (~216 KB) and Tailwind
  (~280 KB) are both inside. `--no-tailwind` drops the latter.
- Bake data in through `--props`; the page reads it as the component's props,
  exactly like image and pdf.
- A warm render takes well under a second: no browser is launched.

## video

Video uses Remotion, so the composition can animate:

```tsx
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const config = { width: 1080, height: 1920, fps: 30, durationInFrames: 90 };

export default ({ title = "Hi" }: { title?: string }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#000", justifyContent: "center" }}>
      <h1 style={{ opacity, color: "#fff" }}>{title}</h1>
    </AbsoluteFill>
  );
};
```

- **Animate from `useCurrentFrame()`**, never from wall-clock time or CSS
  animations. Every frame is rendered independently, so anything not derived
  from the frame number will not animate.
- Always clamp: `interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" })`.
  Without it values keep going past the range.
- Use `<Sequence from={30} durationInFrames={60}>` to time sections.
- **`export const config`** sets `width`, `height`, `fps` and
  `durationInFrames`. Flags override it; an unset flag never overrides it.
- `--duration` is in **frames, not seconds** — at 30fps, 90 frames is three
  seconds.
- **CSS `transition` and `animation` do not work**, nor Tailwind animation
  classes — every frame is rendered independently, so they render as one static
  state. See [remotion.md](remotion.md) for the animation rules, media
  components, and how to look up current Remotion docs.

### Iterate with `--frame`, then encode

```bash
infer render video intro.tsx --frame 45 -o check.png   # one frame, no encoding
```

This renders a single frame as a still and skips encoding entirely, and it is
frame-exact — what you see is what the video will contain at that frame. **Use
it to check your work and correct it before rendering the whole thing.** A good
loop is: render frame 0, the middle frame and the last frame, look at each, fix,
then encode.

### Licence

Remotion is free for individuals, non-profits and for-profit organisations with
up to 3 employees. Larger organisations need a paid company licence
(<https://remotion.pro>). The CLI prints this on every video render. If the user
may be affected, tell them plainly — do not bury it.

## Assets

This is the one place the subcommands differ, and it is easy to get wrong.

**image and pdf** — pass `--assets <dir>` and reference files by **plain
relative URL**:

```bash
infer render image card.tsx --assets ./public
```

```tsx
<img src="img/logo.png" />        {/* resolved against the assets dir */}
```

**html** — the same `--assets` and plain relative URLs, but each file is
**embedded** in the page as a data URI, so the page carries it. A string in the
composition or in `--props` is embedded when it names a file in the directory.
Importing works too and needs no `--assets` at all:

```tsx
import logo from "./logo.png";    // always embedded, the most robust form
<img src={logo} />
```

A path **assembled at runtime** — `` `img/${n}.png` `` — cannot be seen, so it
is not embedded and will not load. Write each path out in full, or import it.
Files over 5 MB are embedded with a warning: base64 grows them by a third.

**video** — pass `--assets <dir>` and use Remotion's `staticFile()`:

```tsx
import { staticFile, Img } from "remotion";

<Img src={staticFile("img/logo.png")} />
```

For image, pdf and video nothing is copied, so a large asset folder costs
nothing. For html only the files the composition names are embedded.

## Requirements and cost

- Image and pdf use Playwright's headless Chrome, **pinned**, so a render does
  not change when the system browser updates. The **first ever** image or pdf
  render downloads it — about 200 MB, roughly a minute — and says so on
  stderr; do not mistake that for a hang. Offline, an installed Chrome is used
  instead. `CHROME_PATH` overrides both.
- After that, images and PDFs render in one to three seconds.
- Video is slower: the first ever video render installs packages and downloads
  a Chrome build, then later renders are a few seconds. Prefer `--frame` while
  iterating.
- Fonts come from the system unless you inject a `<link>` with `--head`.
- **Tailwind is v4** for image, pdf and html, inlined into the page, so class names
  work offline with no setup. Most Tailwind you have seen is v3; the
  differences that bite:
  - `bg-opacity-50` and friends are gone and silently do nothing. Use the slash
    form: `bg-black/50`, `text-white/80`.
  - A bare `border` takes the text colour, not grey. Name it: `border border-zinc-200`.
  - Gradients are `bg-linear-to-r` (the old `bg-gradient-to-r` still works).
  Class names built at runtime (`` `bg-${color}-500` ``) do work here, because
  Tailwind compiles in the page. `--no-tailwind` skips it.

## Output

Only the written path goes to stdout, so it chains:

```bash
open "$(infer render image card.tsx -o card.png)"
```
