# infer meeting

Records the user's microphone and the computer's audio (everyone else on the
call) as two tracks, then transcribes both with Groq Whisper into one
time-ordered transcript labelled by track. macOS 15+ only.

```bash
infer meeting --me Jimi --them Client --language fr   # records until Enter or Ctrl-C
infer meeting --duration 45                            # or stops after 45 minutes
infer meeting --from meetings/2026-10-02-1430          # transcribe an earlier recording again
```

- **It is interactive and long-running**: it records until the user presses
  Enter or Ctrl-C. Start it in a terminal the user controls, or pass
  `--duration` when running it yourself. Ctrl-C stops the recording and still
  transcribes; it does not abort.
- stdout is the path of `transcript.md`. The folder also holds the two audio
  tracks (`mic.caf`, `system.caf`, 16 kHz), Groq's raw response per track
  (`mic.transcript.json`, `system.transcript.json`) and `transcript.json`.
- **Speaker labels come from the tracks, not diarization**: `--me` is the
  microphone, `--them` is everyone on the computer's audio, together.
- **No cleanup is done.** The transcript is speech recognition as heard: names
  and product terms may be misheard ("version OZ" for "version onze"). When
  the user asks for notes, a summary or action items, read `transcript.md` and
  write them yourself, fixing obvious misrecognitions from context.
- On speakers rather than headphones the mic also hears the other side; such
  echoes are removed from `--me` when they repeat what `--them` said at the
  same moment. The raw per-track files keep everything, if something seems
  missing.
- Audio is written as it records. If a run was interrupted or transcription
  failed, `--from <dir>` transcribes what is there.
- The first run compiles a small Swift helper (needs the Xcode Command Line
  Tools), and macOS asks the user to allow their terminal under Screen &
  System Audio Recording and Microphone.
