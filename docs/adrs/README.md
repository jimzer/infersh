# Architecture decision records

Durable decisions and the facts behind them — especially the ones that cost
time to discover and would otherwise be rediscovered the hard way.

| # | Decision |
| --- | --- |
| [1](0001-effect-v4-on-bun.md) | Effect v4 on Bun, and why both packages move together |
| [2](0002-api-keys-in-the-os-credential-store.md) | API keys in the OS credential store, behind an Effect service |
| [3](0003-ship-a-single-file-bun-bundle.md) | Ship a single-file Bun bundle — and why `--banner` breaks it |
| [4](0004-resolve-releases-through-the-api.md) | Resolve releases through the API, not `latest/download` |
| [5](0005-self-replacing-updates.md) | Self-replacing updates |
| [6](0006-just-as-the-task-runner.md) | Just as the task runner |
| [7](0007-notify-on-startup-install-on-request.md) | Notify on startup, install on request — why not auto-update |
| [8](0008-upload-assets-by-existence-not-field-name.md) | Upload assets by existence, not by field name |
| [9](0009-preprocess-audio-with-ffmpeg-by-default.md) | Preprocess audio with ffmpeg by default |
| [10](0010-bright-data-over-rest-not-the-sdk.md) | Bright Data over REST — why the official SDK cannot run on Bun |
| [11](0011-billed-limits-are-required-not-defaulted.md) | Billed limits are required, never defaulted |
| [12](0012-render-in-an-isolated-child.md) | Render in an isolated child — auto-installed deps, no asset server |
| [13](0013-video-through-remotion.md) | Video through Remotion — and its licence consequence |
| [14](0014-budget-reports-what-each-provider-exposes.md) | `budget` reports what each provider exposes, and no more |
| [15](0015-openrouter-over-http-and-unboundable-cost.md) | OpenRouter over HTTP, and why the search command was dropped |
| [16](0016-ui-blocks-so-the-parent-owns-the-server.md) | `infer human` (formerly `infer ui`) blocks, so the parent owns the server |
| [17](0017-social-datasets-the-docs-are-wrong.md) | The social dataset docs are wrong in three places |
| [18](0018-keep-playwright-for-now-over-bun-webview.md) | Keep Playwright for now, over Bun.WebView |
| [19](0019-effect-v4-stable.md) | Effect v4 stable — the renames, and the one that typechecks |
| [20](0020-tailwind-v4-inlined.md) | Tailwind v4, inlined into every page — and why not the CDN or a build step |
| [21](0021-render-html-one-portable-file.md) | `render html` writes one portable file — and three Bun traps on the way |
| [22](0022-render-on-playwrights-pinned-headless-shell.md) | Render on Playwright's pinned headless shell — 2.6x faster, and stable across browser updates |
| [23](0023-staging-on-effect-filesystem-and-childprocess.md) | Staging on Effect's FileSystem and ChildProcess |
| [24](0024-effect-schema-for-all-parsing.md) | Effect Schema for all parsing — leniency declared, passthrough checked with Schema.is |
| [25](0025-video-pinned-sized-by-props-and-batched-stills.md) | Video: pinned Remotion, size from props, batched stills |
| [26](0026-ui-serves-one-prebuilt-page.md) | `ui` serves one prebuilt page, gzipped, and reports over stdout |
| [27](0027-shot-captures-live-pages-through-the-render-worker.md) | `infer shot` captures live pages through the render worker |
| [28](0028-each-keeps-results-by-filled-command.md) | `infer each` keeps results by filled command, and runs without a shell |
| [30](0030-media-ffmpeg-jobs-with-correct-defaults.md) | `infer media`: ffmpeg jobs with the defaults decided once |
| [31](0031-fetch-fal-specs-ourselves-parser-only-dereferences.md) | Fetch fal specs ourselves; the OpenAPI parser only dereferences |

## Writing one

One decision per file, numbered sequentially: context, the decision, then the
consequences — including what broke and how it was found. A consequence worth
recording is one that would change what someone does next; the failure modes
matter more than the rationale.
