# 14. `budget` reports what each provider exposes, and no more

## Status

Accepted.

## Context

Every provider here is pay-as-you-go, so "how much is left?" is a question
worth asking before starting a job — especially for an agent about to spend
money on someone's behalf. The three providers answer it very differently, and
each answer was verified against the live APIs rather than taken from docs:

| provider | endpoint | auth | result |
| --- | --- | --- | --- |
| fal.ai | `GET /v1/account/billing?expand=credits` | `Authorization: Key …`, **Admin scope** | `{username, credits:{current_balance, currency}}` |
| Bright Data | `GET /customer/balance` | `Authorization: Bearer …` | `{balance, credit, prepayment, pending_costs}` |
| Groq | — | — | nothing; the console only |

Three findings shaped the design:

**fal needs a different key than the rest of the CLI does.** fal keys carry a
scope. An API-scope key runs models and reads model metadata; account billing is
Admin-scope only, and an API-scope key gets `403 authorization_error`. The 403
is scope, not a wrong path — `/v1/keys`, also Admin-only, fails identically on
the same key that gets 200 from `/v1/models`. Admin scope is a superset, so one
Admin key in `FAL_KEY` covers both jobs and no second key slot is needed.

`expand=credits` is not optional. Without it the endpoint returns 200 with only
`{"username":…}` — a success that contains no balance.

The other paths listed in fal's platform-API index — `/v1/usage`,
`/v1/billing-events`, `/v1/analytics` — are all `404 Route not found` at
`api.fal.ai`. Only `account/billing` was confirmed to exist.

**Bright Data's field names disagree with its own docs.** The live response
returns `pending_costs`; the documented shape says `pending_balance`. Both are
read, live name first. The endpoint reports no currency at all, and Bright Data
accounts are USD-denominated, so USD is supplied by us — the one figure in the
output that is an assumption rather than a reading.

**Groq has no billing API.** Its spend-limits documentation says management is
console-only. Groq does return rate-limit headers on inference responses
(`x-ratelimit-remaining-tokens`, `x-ratelimit-remaining-requests`), and those
were briefly considered as a stand-in.

Note for anyone searching this later: web results about a Groq "management API"
at `management-api.x.ai` describe **xAI's Grok**, a different company. It does
not apply.

## Decision

**One command, `infer budget`, reporting per provider, never failing as a
whole.** Each provider's outcome is a variant — balance, no key, key denied,
no such API, request failed — carried as data. A provider that cannot answer is
part of the answer. The command always exits 0; `--json` exposes a `status`
field (`ok`, `no-key`, `no-api`, `denied`, `error`) to branch on, so a caller
never parses prose.

The reasoning: the failure modes here are ordinary and expected — a key not set
yet, a key of the wrong scope, a provider with no such API. If any one of them
aborted the run, the most common case (two providers answer, one cannot) would
print nothing useful.

**Groq is reported as unsupported rather than approximated from rate-limit
headers.** Those headers describe the current window's token quota, not money,
and would mislead anyone reading a column of dollar figures. Worse, obtaining
them requires issuing a billed inference request — a command whose purpose is
watching spend must not spend to answer. A console link is the honest output.

**A 200 that yields no balance is an error, not a zero.** If a response shape
changes, the report says it could not read a balance and includes the body.
Printing `$0.00` would be indistinguishable from a genuinely empty account, and
that is exactly the reading someone would act on.

**Currencies are summed separately.** `totals` groups by currency rather than
adding unlike numbers, even though everything is USD today.

## Consequences

- Running models and reading the fal balance want the same key, but only an
  Admin-scope key does both. Someone using an API-scope key sees a clear
  explanation on the `fal` row instead of a generic 403.
- Bright Data's `currency: "USD"` is our assumption. If Bright Data ever bills
  another currency, this is where it would be wrong.
- Groq's row will stay a link until Groq ships an API. If it ever does, only
  `check`'s `groq` branch changes.
- Balances lag real usage — providers settle on their own schedules — so the
  figures are recent rather than exact, and the command says so.
