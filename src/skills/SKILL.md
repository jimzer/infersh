---
name: infer
description: Use the infer CLI to render TSX compositions into images, PDFs and videos, run fal.ai models, scrape the web and search with Bright Data, and transcribe audio with Groq. Use when asked to generate an image or video from code, render a PDF, produce an OG image or social clip, run an AI image or video model, scrape a page, search the web, find YouTube videos, or transcribe audio.
---

# infer

A single CLI over several inference and rendering providers. Every command
prints its result to **stdout** and progress to **stderr**, so output is always
safe to pipe.

## Before anything else

`--help` is exhaustive and always current. Read it rather than guessing flags:

```bash
infer --help
infer render video --help
```

This skill covers **how to work with** each area — the contracts, the idioms
and the traps. It deliberately does not list every flag, because `--help`
already does that and cannot go stale.

## Areas

| area | what it does | reference |
| --- | --- | --- |
| `infer render` | TSX component → PNG / JPEG / WebP / PDF / MP4 | [render.md](references/render.md) |
| ↳ video | writing animated compositions, and looking up Remotion docs | [remotion.md](references/remotion.md) |
| `infer fal` | fal.ai models: search, inspect, run | [fal.md](references/fal.md) |
| `infer bdata` | Bright Data: scrape pages, search engines, YouTube | [bdata.md](references/bdata.md) |
| `infer groq` | Groq Whisper speech-to-text | [groq.md](references/groq.md) |

Read the reference file for the area you are working in. Do not read all of
them.

## Keys

Providers need API keys. They resolve from the environment first, then the OS
credential store:

| provider | env var |
| --- | --- |
| fal.ai | `FAL_KEY` |
| Bright Data | `BRIGHTDATA_API_KEY` |
| Groq | `GROQ_API_KEY` |

```bash
infer keys list    # which keys are set, masked, and where each resolves from
infer keys set     # store them interactively (needs a terminal)
infer keys rm fal  # forget a stored key
```

`infer render` needs no key at all. If a command fails with "No … API key
found", say so rather than trying to work around it — the user has to supply
the key.

## Rules that apply everywhere

- **stdout is the result, stderr is the noise.** `infer fal run … | jq` and
  `infer render image … | xargs open` both work. Never parse stderr.
- **A failure exits non-zero with a message on stderr.** Read the message; it
  usually names the fix.
- Where a flag bounds something **billed**, it is required rather than
  defaulted. If a command refuses to run without a limit, that is deliberate —
  pick a small one rather than the largest you can imagine.
