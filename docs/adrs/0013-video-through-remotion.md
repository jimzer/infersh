# 13. Video through Remotion

- Status: accepted
- Date: 2026-07-30

## Context

`render image` and `render pdf` take a TSX component and props. Video needs a
frame-by-frame renderer, and the two candidates were Remotion and HeyGen's
HyperFrames.

## Decision

Use Remotion. Keep the isolated-temp-directory shape from ADR 12, but install
dependencies for real instead of relying on Bun's runtime auto-install.

## Consequences

**Remotion is not open source, and that is a shipped consequence.** Its licence
grants free use to individuals, non-profits and for-profit organisations with
up to 3 employees; anyone larger needs a paid company licence. This CLI has a
public installer, so a person at a 12-person company could otherwise acquire
that obligation without ever seeing Remotion named. The licence is therefore
printed to stderr on every video render and stated in `--help`.

Remotion also never becomes a dependency of this repo: the composition root,
entrypoint and worker are string constants in `render-video-source.ts`, so
`bun install` here pulls nothing from Remotion and the obligation stays with
whoever runs the command.

**HyperFrames was the near miss.** Apache 2.0 and file-oriented — the `blank`
template is a single self-contained `index.html`, contradicting an earlier
assumption that it needed a scaffolded project. It was rejected because its
compositions are HTML with a paused GSAP timeline rather than TSX with props,
and because `onnxruntime-node` — a hard dependency, 208 MB, shipping every
platform's native runtime in one package — is pulled in for ASR and background
removal that a plain render never loads.

**Auto-install cannot work here.** Remotion bundles with Rspack, which resolves
modules from the filesystem, and `bun --install=fallback` never creates a
`node_modules` — it resolves in-process. So video does a real `bun install` in
the staged directory. Warm, from Bun's global cache, that is well under a
second, and the package set is nearly constant.

**Inlining dependencies was considered and rejected.** Bundling everything
except react/remotion into one file produced a 4 KB entry, but it cannot remove
the install (Rspack still needs its externals on disk), only moves work Rspack
already does quickly, and bypasses Remotion's own loaders for CSS, assets and
media. `Bun.build` also cannot auto-install, so the deps must be present
regardless. The flatten pass therefore keeps `packages: "external"` and exists
only to inline *relative* imports — which is what lets the composition leave
its own project — and to harvest the dependency list from the bundle's
remaining bare specifiers, which is more reliable than parsing the source.

**Bun compiles JSX to the dev runtime by default, and that breaks Remotion.**
The first working render failed at the first frame with
`(0, jsx_dev_runtime.jsxDEV) is not a function`, because Remotion's production
bundle resolves `react/jsx-dev-runtime` without that export. Passing
`define: { "process.env.NODE_ENV": '"production"' }` switches Bun to `jsx` from
`react/jsx-runtime`. `production: true` does **not** — it sets minification and
leaves the dev runtime in place. Only the video path needs this; the image
child runs under Bun, where the dev runtime is fine.

**Configuration is merged, not baked.** The staged `Root.tsx` imports
`config.json` and layers built-in defaults, then a `config` export on the
composition, then only the flags that were explicitly passed. So a flag always
wins and an unset flag never overrides the composition's own choice — verified
by a composition exporting 1280x720/30fps/45 frames rendering as
640x360/24fps/20 frames under flags.

`publicDir` with `symlinkPublicDir: true` serves assets from wherever they
already are, so a large asset folder is never copied into the temp directory.
Note this makes video's asset idiom `staticFile("img/logo.png")` rather than
the plain relative URLs that image and pdf resolve through interception.

Rspack is enabled through the public `bundle({ rspack: true })` option. An
earlier reading of `index.ts` suggested it was only reachable via
`BundlerInternals`; in fact `rspack`, `publicDir` and `symlinkPublicDir` are all
on the public `BundleOptions` type, despite living in a type named
`MandatoryBundleInternalsOptions`.

`--frame` renders one frame with `renderStill` instead of encoding, which is
what makes it useful for checking a composition mid-iteration. Verified to be
frame-exact: the still at frame 30 is pixel-identical to frame 30 extracted
from the encoded video.

Temp directories are removed on success *and* failure by
`Effect.acquireUseRelease`, verified by rendering repeatedly and after
deliberate failures with nothing left behind. `rmSync` unlinks the
`node_modules/.remotion` symlink rather than following it, so the shared
browser cache survives — worth knowing, because following it would silently
delete a 193 MB download on every render.

The Chrome Headless Shell that Remotion downloads is shared across renders by
symlinking `$XDG_CACHE_HOME/infer/remotion` in as `node_modules/.remotion`.
Without it every render from a fresh temp directory would re-download it.
