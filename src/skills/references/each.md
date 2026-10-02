# infer each

Run one command per row of a JSONL file — instead of a shell loop. Built for
running an infer command over a list, and for finishing that list across
interruptions and failures without paying twice. Needs no API key itself.

```bash
infer each urls.jsonl -c 8 -- infer bdata scrape {url} --data-format markdown --json > pages.jsonl
```

## Input

One JSON object per line. Blank lines are skipped; any other line that is not
an object refuses the whole input before anything runs. `-` reads stdin:

```bash
jq -c '.items[]' data.json | infer each - -- infer shot {url} -o shots/{id}.png --json
```

Have a JSON array? `jq -c '.[]'` turns it into JSONL.

## Placeholders

Everything after `--` is the command, as argv. `{field}` is replaced by that
field of the row; `{a.b}` reaches a nested field, `{tags.0}` an array item.
Numbers and booleans are written as text, objects and arrays as JSON.

- **No shell is involved.** Each argument is filled on its own and passed
  straight to the program, so a value with spaces, quotes, `$` or `;` stays
  exactly one argument and is never interpreted. Do not wrap placeholders in
  extra quotes "for safety" — they would end up in the argument.
- Shell-quote the template itself as usual: `'Summarise: {text}'`.
- A row that lacks a field the command uses (or has it `null`) is not run; its
  output line says which field. Fix the row — retrying will not help.
- JSON written into an argument keeps its own braces: in
  `--input '{"prompt":"{topic}"}'` only `{topic}` is a placeholder. But a value
  with a `"` would break that JSON, since values are inserted as they are;
  prefer separate flags (`--prompt {topic}`) when a command has them.

Check what will run, for free, before a paid run:

```bash
infer each items.jsonl --dry-run -- infer openrouter response openai/gpt-5-mini --prompt 'Summarise: {text}' --json
# {"line":1,"row":{…},"argv":["infer","openrouter",…],"reused":false}
```

## Output

stdout is JSONL, **one line per input row, in input order**, whatever order the
rows finish in:

```json
{"line":1,"row":{"url":"…"},"ok":true,"result":{…},"reused":false}
{"line":2,"row":{"url":"…"},"ok":false,"error":"…last of stderr…","exitCode":1,"attempts":3}
```

- `result` is the command's stdout, parsed when it is JSON, else a string. So
  pass `--json` to infer commands — you get structured results, not text.
- `line` is the row's line number in the input; `row` is the row itself, so
  the output stands alone.
- `--json` prints one array of the same objects at the end instead.
- Progress goes to stderr. Exit 0 means every row succeeded; otherwise every
  line is still printed and the exit is 1.

```bash
infer each in.jsonl -- … > out.jsonl
jq -c 'select(.ok) | .result' out.jsonl
jq -c 'select(.ok | not) | {line, error}' out.jsonl
```

## Resuming: results are kept

Every success is saved the moment it lands, keyed by the exact filled command.
**Run the same `infer each` again** — same command, same directory — and every
row that already succeeded is reused (`"reused":true`, nothing run, nothing
billed); only missing and failed rows run. Repeat until it exits 0.

- Interrupted (Ctrl-C, killed, crashed)? Re-run the same line. The commands
  still running when it was stopped are killed, not left behind.
- Edited a row? It fills to a new command and runs; the others are reused.
- Rows that fill to the identical command run once and share the result.
- Kept means the command exited 0. If a result is wrong anyway — an empty
  answer, an output file since deleted — it is still reused. `--fresh` forgets
  every kept result for this command and runs everything.
- Results live in `~/.cache/infer/each/` (`$XDG_CACHE_HOME/infer/each/`), one
  file per command template and directory; stderr names it. Deleting the folder
  is always safe.

## Concurrency, retries, timeouts

- `-c` / `--concurrency` (default 4): rows in flight at once. Scrapes and API
  calls can go higher; renders are heavy locally; mind provider rate limits.
- `--retries` (default 2): a command that exits non-zero or times out is tried
  again after about 1 s, then 2 s, 4 s… A command that cannot start at all is
  not retried.
- `--timeout <seconds>`: kill a row's command after that long; it counts as a
  failed attempt.

## Money

`each` multiplies whatever the command costs by the number of rows. Before a
billed run over many rows: `--dry-run` to check the commands, run the first few
rows (`head -3 in.jsonl | infer each - -- …`), and check `infer budget`. Their
results are kept, so the full run afterwards does not pay for them again.

Not covered: pipelines of several dependent steps. Chain two `each` runs
through `jq` instead.
