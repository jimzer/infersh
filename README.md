# infer

A single-file CLI for running inference providers, built with [Effect](https://effect.website) and [Bun](https://bun.sh).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jimzer/infersh/main/install.sh | sh
```

Installs to `~/.local/bin/infer` (override with `INFER_BIN_DIR`). Requires [bun](https://bun.sh) on your `PATH` — the release is a single minified `.js` file with a `#!/usr/bin/env bun` shebang, so there is nothing else to install.

Update in place:

```bash
infer update          # download and install the latest release
infer update --check  # just report whether one is available
```

## Usage

```bash
infer keys set     # prompt for each provider API key (masked)
infer keys list    # show which keys are set, masked, and where they resolve from
infer keys rm fal  # delete a stored key
```

Keys live in the OS credential store — the macOS Keychain, libsecret on Linux, or the Windows Credential Manager — never in a dotfile. The matching environment variable takes precedence when set, so CI can inject a key without prompting:

| provider | env var |
| --- | --- |
| `fal` | `FAL_KEY` |
| `brightdata` | `BRIGHTDATA_API_KEY` |
| `groq` | `GROQ_API_KEY` |

## Development

```bash
just install    # bun install
just checkall   # biome + tsc + tests
just bundle     # build dist/infer.js
just run --help # run from source
```

Running from source reports version `dev`, and `infer update` refuses to overwrite a checkout.

Design decisions and the gotchas behind them are recorded in [`docs/adrs`](docs/adrs/).

## Releasing

Push to `main` runs `just checkall` and `just bundle`. Publishing a GitHub release tagged `vX.Y.Z` builds the bundle stamped with that tag and attaches `infer.js` to the release, which is what `install.sh` and `infer update` download.

To cut one, run the `/release` skill: it reads the full diff since the previous release, classifies it into breaking changes, features and fixes, derives the version from that, writes the notes, verifies the published artifact reports the tagged version, and finally smoke tests the result by running `infer update` on the local install through the official channel.
