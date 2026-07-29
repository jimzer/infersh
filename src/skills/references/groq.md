# infer groq

Speech-to-text with Groq's Whisper models — fast enough to feel instant.

```bash
infer groq transcribe --file talk.m4a
infer groq transcribe --file talk.m4a --response-format text
infer groq transcribe --url https://example.com/long.mp3
```

Needs `GROQ_API_KEY`.

## Picking the output shape

- **`--response-format text`** when you just want the words, e.g. to summarise
  or pipe onward. No JSON to unwrap.
- `json` (the default) gives the text plus a little metadata.
- `verbose_json` adds per-segment timestamps and quality scores. Required for
  timestamps:

```bash
infer groq transcribe --file talk.m4a \
  --response-format verbose_json --timestamp-granularities word
```

`--timestamp-granularities word` gives word-level start/end times; `segment`
gives full segment metadata. Repeat the flag for both. Requesting only `word`
leaves `segments` null — that is the API's behaviour, not an error.

## Facts that change what you do

- **Direct upload is capped at 25 MB.** Larger files must be hosted and passed
  with `--url`. There is no way around it.
- **Every request is billed as at least 10 seconds**, however short the clip.
  Batching several short clips into one file is cheaper than many tiny calls.
- **Only the first audio track is transcribed.** A dubbed video yields its
  original language, not the dub.
- Audio is converted to 16 kHz mono FLAC with ffmpeg before upload, which is
  what Groq downsamples to anyway. It roughly halves the file and means
  **anything ffmpeg can read works** — including formats Groq does not list,
  such as `.aiff`. `--no-optimize` skips it, and then only Groq's own formats
  are accepted.

## Accuracy

- **`--language en`** (ISO-639-1) when you know the language. Improves both
  accuracy and latency. Omit it only to auto-detect.
- `--prompt` guides spelling and style, not instructions — give it names,
  jargon or the topic, written in the same language as the audio. Max 224
  tokens.
- Default model is `whisper-large-v3-turbo`: cheapest and fastest, ~12% word
  error rate. Use `whisper-large-v3` when accuracy matters more than cost
  (~10.3%).
- Leave `--temperature` at 0 for transcription.
