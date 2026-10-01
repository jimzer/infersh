# 19. Effect v4 stable — the renames, and the one that typechecks

- Status: accepted
- Date: 2026-10-01

## Context

Effect v4.0.0 shipped. npm's `latest` tag now points at it, which retires the
central warning of [ADR 1](0001-effect-v4-on-bun.md): `bun update --latest`
no longer drags the project back to v3.

Going from `4.0.0-beta.102` to `4.0.0` is not a version bump. The beta's
`unstable` namespace graduated and most constructors were renamed.

## Decision

Depend on `effect@^4.0.0` and `@effect/platform-bun@^4.0.0`, importing from the
graduated paths.

## Consequences

**`effect/unstable/*` became `effect/*`.** `effect/unstable/cli` → `effect/cli`,
`effect/unstable/http` → `effect/http`. Nothing else about those modules moved.

**Constructors are capitalized, and two were renamed outright.** They read as
type names now, which is the tell for which identifier to reach for:

| beta.102 | 4.0.0 |
| --- | --- |
| `Flag.string` / `Argument.string` | `Flag.String` / `Argument.String` |
| `Flag.integer` | `Flag.Int` |
| `Flag.float` | `Flag.Finite` |
| `Flag.boolean` | `Flag.Boolean` |
| `Flag.choice` / `Argument.choice` | `Flag.Literals` / `Argument.Literals` |
| `Prompt.password` / `Prompt.confirm` / `Prompt.select` | `Prompt.Password` / `Prompt.Confirm` / `Prompt.Select` |

`Literals` takes the same `(name, readonly string[])` as `choice` did and still
narrows to the literal union, so those call sites port unchanged. Use
`Flag.ChoiceWithValue` only when accepted strings must map to other values.

**`Flag.Boolean` no longer defaults to `false`.** This is the one that costs
time. In the beta an absent boolean flag was `false`; in 4.0.0 *omission is an
error* unless the flag is given `Flag.optional` or `Flag.withDefault`. It
typechecks perfectly either way — `Flag<boolean>` is `Flag<boolean>` — so the
whole CLI compiles and then fails at runtime on the first invocation that
leaves a switch off:

```
$ infer keys list
ERROR
  Missing required flag: --json
```

Every one of our 20 boolean flags is a switch that means `false` when absent, so
all 20 carry `Flag.withDefault(false)`. A new boolean flag needs it too.

Typechecking is therefore not sufficient evidence for this upgrade. The cascade
is also misleading: a single bad import path (`effect/unstable/cli`) degrades
every flag in the file to `unknown`, which surfaces as dozens of unrelated
`implicitly has an 'any' type` errors. Fix the import paths first and re-run
before reading any other error.

**Flags that are genuinely required stayed required.** `--limit` and
`--num-of-posts` still have no default, which is
[ADR 11](0011-billed-limits-are-required-not-defaulted.md) working as intended.
