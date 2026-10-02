# 28. `infer each` keeps results by filled command, and runs without a shell

- Status: accepted
- Date: 2026-10-02

## Context

Agents ran infer commands over lists with shell loops: fragile quoting, no
bound on concurrency, no retries, and an interruption meant either re-running
— and re-paying for — everything, or working out by hand what had finished
(issue #2). The decision on that issue: results are kept by default, with no
opt-in flag, and re-running the same command finishes the job.

## Decision

`infer each <input.jsonl> [flags] -- <command…>`, in `src/each.ts`.

- **argv, never a shell.** The part after `--` arrives as argv (Effect CLI hands
  everything after `--` to the positional arguments untouched, flags included).
  `{field}` placeholders are filled per argv element and the command is run
  through `stage.ts`'s `run()` — Effect `ChildProcess`, no shell — so a value
  with spaces, quotes or `$(…)` is exactly one literal argument. A placeholder
  is `{` + a letter or `_` + name chars + `}`, with dotted paths, so JSON in an
  argument (`{"prompt":"{topic}"}`) keeps its own braces. A filled value is
  never re-scanned. Field lookup uses own properties only (`{constructor}` is
  missing, not `Object`). A missing or `null` field fails that row, unrun, with
  the field named.
- **Input is validated whole, first.** A line that is not a JSON object stops
  the run before anything starts, naming the line: a half-run over a malformed
  file is worse than a refusal. `-` reads stdin through the `Stdio` service.
- **Output is stdout, JSONL, one line per input row, in input order** —
  `{line,row,ok,result,reused}` or `{line,row,ok:false,error,exitCode?,attempts}`.
  `result` is stdout parsed as JSON when it is, else the text. `--json` gives
  one array instead, for the CLI-wide contract. No `--output` file: the
  journal (below) is the stable place resumption reads from, so stdout can be
  redirected anywhere and is complete on every run, reused rows included.
- **The journal** is `<cacheDir>/each/<sha256(cwd, template)[:16]>.jsonl`,
  append-only, one `{key, argv, result}` line per success, written the moment
  a row succeeds. A row's key is the SHA-256 (Effect `Crypto`) of its filled
  argv. The working directory is part of the journal's identity because a
  relative path in a command (`-o shots/{id}.png`) means a different file
  elsewhere. Failures are not journaled: they simply run again.
- **Forcing a rerun** is `--fresh`, which deletes this command's journal before
  running. Deleting `~/.cache/infer/each` is always safe.
- Concurrency is `Effect.forEach({ concurrency })` over the *distinct* filled
  commands; retries are `Effect.retry` with `Schedule.exponential("1 second")`
  jittered, `--retries` times (default 2), only for non-zero exits and
  timeouts — a command that cannot start is not retried. `--timeout` is
  `Effect.timeoutOrElse`, whose interruption closes the child's scope and
  kills it. `--dry-run` prints the filled argv per row, and whether a kept
  result would be used, without running anything.

## Consequences

**Keying on the filled command, not the row or the file, is what makes resume
predictable.** Same input file contents and same template give the same keys,
whatever the file is called or wherever the rows came from — `head -3
in.jsonl | infer each - -- …` as a trial, then the full file, pays for those
three once. An edited row fills to a new command and runs; a change to a field
the command does not use changes nothing, correctly. Rows that fill to the
identical command run once and share the result, within a run as well as
across runs. The flip side: "run this prompt five times" needs a field that
differs per row *in the command* (`--seed {i}`).

**Kept means exited 0.** A result that exited 0 but is useless — an LLM answer
cut short by `--max-tokens`, seen in the verification run — or a written file
deleted since, is still reused. `--fresh` is the only way to redo it; there is
no per-row forget yet. If that is wanted, it belongs as a filter flag, not a
change to the keying.

**A signal to `each` alone orphaned its children.** `main.ts` runs the CLI with
`Effect.runPromise`, which installs no signal handlers, so `kill -INT <pid>`
ended the parent at once and its running commands carried on, unobserved:
work done (and billed) whose results nobody recorded, then done again on
resume. A terminal's Ctrl-C hid this, because it signals the whole foreground
process group, children included. `runEach` now races the rows against a
SIGINT/SIGTERM listener (`Effect.callback`); the signal interrupts the rows,
every child's scope closes and kills it, and the run fails with a message
saying the finished rows are kept. Verified: `kill -TERM` mid-run left no
child processes and the next run ran only the unfinished rows. Moving the
whole CLI to `BunRuntime.runMain` would give every command this; that was left
alone here because it changes `main.ts`'s exit handling for every command.

**Output order without head-of-line blocking.** `Stream.mapEffect` with
concurrency keeps order but does so by holding a window of in-flight effects,
so one slow row stalls new starts. Rows instead run unordered and pass through
a small reorder buffer (`inOrder`), behind a one-permit `Semaphore` shared with
journal appends — so lines leave in input order and the journal is written a
whole line at a time even with many rows finishing together. The cost: on an
interrupted run, stdout lacks lines finished behind a slower earlier row; the
journal has them, and the re-run prints everything.

**A half-written last journal line is skipped**, by decoding each line on its
own (`decodeEach`); that row just runs again. Effect's `Ndjson` channel was
considered for both files but fails the stream on the first bad line and
carries no line numbers, which are what the input error needs.

**Children get an empty stdin** (`stdin: "ignore"`, a new `run()` option):
`ChildProcess` defaults to a pipe nobody writes to, so a command that reads
stdin would hang forever.

Verified end to end with the bundle: 10 rows at `-c 3` peaked at exactly 3 in
flight; with rows 3 and 7 failing (`--retries 1`, 12 invocations), the re-run
invoked only those two and exited 0; `kill -TERM` mid-run, then a re-run that
invoked only the 2 unfinished rows; values with spaces, `"`, `'` and `$(…)`
arriving as single literal arguments; `--timeout`; stdin input; and real
`infer shot`, `infer openrouter models` and `infer openrouter response` runs,
the last re-run at no cost from kept results.
