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

`infer` also checks for updates on its own, at most once a day, and prints a one-line notice when a newer version exists. The check runs after your command, never delays it, and is skipped when output is piped, when `CI` is set, or when running from source.

| variable | effect |
| --- | --- |
| `INFER_AUTO_UPDATE=1` | install updates automatically instead of just notifying |
| `INFER_NO_UPDATE_CHECK=1` | disable the check entirely |

## Usage

### fal.ai

```bash
infer fal models --q "text to image"        # search models
infer fal models --category image-to-video  # filter by category
infer fal schema fal-ai/flux/dev            # a model's input schema, $refs resolved
infer fal run fal-ai/flux/schnell --input '{"prompt":"a red apple"}'
infer fal cdn ./cat.png                     # upload to the fal CDN, print the URL
```

By default `run` prints the raw JSON result. With `--output` it downloads the produced assets instead and prints the paths it wrote:

```bash
infer fal run fal-ai/flux/schnell --input '{"prompt":"a lemon"}' --output ./lemon.jpg
# ./lemon.jpg

infer fal run fal-ai/flux/schnell --input '{"prompt":"a lemon","num_images":3}' --output ./lemon.jpg
# ./lemon.jpg  ./lemon-2.jpg  ./lemon-3.jpg

infer fal run fal-ai/flux/schnell --input '{"prompt":"a lemon","num_images":2}' --output ./shots/
# keeps the model's own filenames inside the directory
```

The raw result still goes to stderr, so the seed and timings are not lost.

Any value in `--input` that is a path to an existing local file is uploaded to the fal CDN and replaced by its URL — at any depth, whatever the field is called. The mapping is printed to stderr, so `infer fal run … | jq` gets clean JSON:

```bash
infer fal run fal-ai/flux/dev/image-to-image \
  --input '{"prompt":"make it snowy","image_url":"./photo.jpg"}'
# uploaded ./photo.jpg -> https://v3b.fal.media/files/b/...
```

### Bright Data

```bash
infer bdata scrape https://example.com --data-format markdown   # LLM-ready text
infer bdata scrape https://example.com --format json | jq       # structured
infer bdata scrape https://a.com https://b.com                  # batch, in parallel
infer bdata search "pizza restaurants" --format json            # Google SERP
infer bdata search "pizza" --engine bing --country gb
```

Options can be passed either as flags or as one JSON object via `--input` — unknown keys are rejected rather than silently ignored.

### Groq

```bash
infer groq transcribe --file talk.m4a                     # transcribe to JSON
infer groq transcribe --file talk.m4a --response-format text
infer groq transcribe --file talk.m4a --response-format verbose_json \
  --timestamp-granularities word                          # word-level timestamps
infer groq transcribe --url https://example.com/long.mp3  # files over 25 MB
```

Audio is converted to 16 kHz mono FLAC with ffmpeg before upload — the same downsampling Groq applies server-side, so there is no accuracy cost. It roughly halves the file and accepts anything ffmpeg can read, not just Groq's own format list. Pass `--no-optimize` to send the file untouched.

### Keys

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
