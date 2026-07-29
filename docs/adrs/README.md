# Architecture decision records

Durable decisions and the facts behind them — especially the ones that cost
time to discover and would otherwise be rediscovered the hard way.

| # | Decision |
| --- | --- |
| [1](0001-effect-v4-beta-on-bun.md) | Effect v4 beta on Bun — and why `bun update --latest` downgrades it |
| [2](0002-api-keys-in-the-os-credential-store.md) | API keys in the OS credential store, behind an Effect service |
| [3](0003-ship-a-single-file-bun-bundle.md) | Ship a single-file Bun bundle — and why `--banner` breaks it |
| [4](0004-resolve-releases-through-the-api.md) | Resolve releases through the API, not `latest/download` |
| [5](0005-self-replacing-updates.md) | Self-replacing updates |
| [6](0006-just-as-the-task-runner.md) | Just as the task runner |
| [7](0007-notify-on-startup-install-on-request.md) | Notify on startup, install on request — why not auto-update |
| [8](0008-upload-assets-by-existence-not-field-name.md) | Upload assets by existence, not by field name |
| [9](0009-preprocess-audio-with-ffmpeg-by-default.md) | Preprocess audio with ffmpeg by default |
| [10](0010-bright-data-over-rest-not-the-sdk.md) | Bright Data over REST — why the official SDK cannot run on Bun |

## Writing one

One decision per file, numbered sequentially: context, the decision, then the
consequences — including what broke and how it was found. A consequence worth
recording is one that would change what someone does next; the failure modes
matter more than the rationale.
