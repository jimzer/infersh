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

## Releasing

Push to `main` runs `just checkall` and `just bundle`. Publishing a GitHub release tagged `vX.Y.Z` builds the bundle stamped with that tag and attaches `infer.js` to the release, which is what `install.sh` and `infer update` download.
