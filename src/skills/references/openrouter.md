# infer openrouter

Run one prompt through any model OpenRouter fronts.

```bash
infer openrouter response anthropic/claude-sonnet-5 --prompt "Explain CRDTs in three sentences."
```

Needs `OPENROUTER_API_KEY`. Check the balance with `infer budget openrouter`.

## What it is for

Reaching a model that no other command wraps. One key gets hundreds of models
from every major provider, addressed by slug (`anthropic/claude-sonnet-5`,
`x-ai/grok-4.5`, `openai/gpt-oss-20b`). Browse them at
<https://openrouter.ai/models>.

The endpoint is **stateless** — there is no conversation history. `--prompt`
carries everything the model sees, so include any context it needs.

## Structured output is the reason to reach for this

`--schema` takes a JSON Schema and forces the answer to match it. stdout then
holds the JSON object itself — no prose around it, no code fences to strip:

```bash
infer openrouter response openai/gpt-oss-20b \
  --prompt "Paris, France, about 2.1 million people" \
  --schema '{"type":"object","properties":{"city":{"type":"string"},"population":{"type":"number"}},"required":["city","population"],"additionalProperties":false}'
# => {"city":"Paris","population":2131577}
```

Rules that matter:

- The top level **must** be `{"type": "object"}`. An array or scalar at the
  root is rejected before the request is sent.
- Set `"additionalProperties": false` and list every key in `"required"`.
  Strict mode is on, and providers reject schemas that leave those open.
- Large schemas go in a file: `--schema @schema.json`.

This is the right tool whenever you need a model's answer as data rather than
prose — classification, extraction, turning a page of text into records.

## Cost

Every call prints what it spent to stderr:

```
[openai/gpt-oss-20b] $0.000016  80 in / 103 out  91 reasoning
```

Rates vary by **orders of magnitude** between models — some are fractions of a
cent per call, frontier models are hundreds of times more. Pick deliberately;
a cheap model is usually right for extraction and classification, and the
`--schema` constraint does much of the work that model quality would otherwise
have to.

`--max-tokens` caps generation. Reasoning models spend those tokens *before*
writing an answer, so a tight cap can leave you with an empty or truncated
reply. If the command warns that the model stopped `incomplete`, raise it.

## Traps

- **Reasoning never reaches stdout.** Pass `--reasoning` to see it on stderr.
  stdout is always just the answer, so `--schema` output stays pipeable.
- **A truncated JSON answer is worse than none.** The command warns on a
  non-`completed` status; heed it rather than piping a half object into `jq`.
- Model slugs are exact. A wrong one is a 400, not a fallback.
