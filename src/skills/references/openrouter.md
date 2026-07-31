# infer openrouter

Run one prompt through any model OpenRouter fronts.

```bash
infer openrouter response anthropic/claude-sonnet-5 --prompt "Explain CRDTs in three sentences."
```

Needs `OPENROUTER_API_KEY`. Check the balance with `infer budget openrouter`.

## What it is for

Reaching a model that no other command wraps. One key gets hundreds of models
from every major provider, addressed by slug (`anthropic/claude-sonnet-5`,
`x-ai/grok-4.5`, `openai/gpt-oss-20b`).

The endpoint is **stateless** — there is no conversation history. `--prompt`
carries everything the model sees, so include any context it needs.

## Finding a model

`models` and `endpoints` need **no API key**, so exploring costs nothing.

```bash
infer openrouter models                                        # all of them
infer openrouter models --author anthropic
infer openrouter models --supports structured_outputs --max-price 0.2
infer openrouter models --min-context 1000000 --limit 10
```

Prints the slug first on each line, so `| awk '{print $1}'` feeds straight
into `response`. Prices are USD per million tokens. `--q` searches id, name
and description; with no flags at all you get the whole catalogue.

`--supports structured_outputs` is the one to reach for when you intend to use
`--schema` — it narrows to models that can honour it.

## Which provider actually serves it

`endpoints` is not a duplicate of `models`. OpenRouter is a *router*: one slug
may be served by a dozen upstream providers, and **they are not
interchangeable**.

```bash
infer openrouter endpoints meta-llama/llama-3.3-70b-instruct
```

```
DeepInfra   ctx=131K  in=$0.1    quant=fp8   up=94%
Novita      ctx=6K    in=$0.135  quant=bf16  up=98%
Together    ctx=131K  in=$1.04   quant=fp8   up=99%
```

For that one model, real numbers: price varies **10×**, context varies **22×**,
and quantization differs (fp8 / bf16 / fp16) which changes output quality for
identical weights.

**The catalogue's `context_length` is the model's headline figure, not what you
will get.** Novita serves that model at 6K when the catalogue says 131K. Before
a long-context job, check `endpoints` — otherwise a request that should work
fails depending on which provider you were routed to.

Uptime is the last 30 minutes. **Latency and throughput are not published by
this API** — the fields exist but come back null on every provider, so they are
not shown. Do not expect to sort by speed.

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
