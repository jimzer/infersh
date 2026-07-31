---
name: infer
description: Use the infer CLI to render TSX compositions into images, PDFs and videos, run fal.ai models, scrape the web and search with Bright Data, transcribe audio with Groq, and show the user an interactive web page to review results or choose between options. Use when asked to generate an image or video from code, render a PDF, produce an OG image or social clip, run an AI image or video model, scrape a page, search the web, find YouTube videos, transcribe audio, run a prompt through any model with JSON-schema output, check how much provider credit is left, or whenever the user should pick, approve, rank or read something that does not fit in a terminal.
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
| `infer openrouter` | find any model and run a prompt through it, with JSON-schema output | [openrouter.md](references/openrouter.md) |
| `infer groq` | Groq Whisper speech-to-text | [groq.md](references/groq.md) |
| `infer ui` | show the user a page and get their answer back | [ui.md](references/ui.md) |

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
| OpenRouter | `OPENROUTER_API_KEY` |

```bash
infer keys list    # which keys are set, masked, and where each resolves from
infer keys set     # store them interactively (needs a terminal)
infer keys rm fal  # forget a stored key
```

`infer render` and `infer ui` need no key at all. If a command fails with "No … API key
found", say so rather than trying to work around it — the user has to supply
the key.

## Money

Every provider is pay-as-you-go. `infer budget` reports what is left:

```bash
infer budget              # every provider
infer budget --json       # status per provider, plus a summed total
```

It always exits 0, because a provider that cannot report is part of the answer.
In `--json`, branch on `status` — `ok`, `no-key`, `no-api`, `denied`, `error` —
never on the prose. Two things to know before reading a low number as alarming:

- **Groq has no billing API at all**, so its row is always a console link. This
  is not a fault to investigate or work around.
- **fal.ai needs an Admin-scope key** for a balance, which is a stricter key
  than running models needs. `denied` on the fal row usually means the key
  works fine for `infer fal run` and simply cannot read billing.

Figures lag real usage, since providers settle on their own schedules. Treat a
balance as recent, not exact, and check it before a large job rather than
after.

## Rules that apply everywhere

- **stdout is the result, stderr is the noise.** `infer fal run … | jq` and
  `infer render image … | xargs open` both work. Never parse stderr.
- **`--json` on any command makes stdout exactly one JSON value.** Prefer it
  over parsing human output — every command accepts it, and payloads that are
  not already JSON get wrapped (a scraped page as `{"content":…}`, a plain-text
  transcript as `{"text":…}`, a render as `{"output":"/path",…}`). Commands whose
  output is already a JSON document, such as `fal schema`, accept the flag and
  are unchanged by it.
- **A failure exits non-zero with a message on stderr.** Read the message; it
  usually names the fix.
- Where a flag bounds something **billed**, it is required rather than
  defaulted. If a command refuses to run without a limit, that is deliberate —
  pick a small one rather than the largest you can imagine.
