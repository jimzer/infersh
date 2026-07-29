# 2. API keys in the OS credential store

- Status: accepted
- Date: 2026-07-29

## Context

The CLI needs provider API keys (fal.ai, Bright Data, Groq). Keeping them in a
dotfile or a shell profile leaks them into backups, shell history and
screenshots.

## Decision

Store keys with `Bun.secrets`, which uses the macOS Keychain, libsecret on
Linux and the Windows Credential Manager. Expose it as an Effect service
(`Context.Service<Secrets, SecretsShape>`), not as free functions.

A private `Store` interface (`get`/`set`/`delete` over plain strings) is the
only part that touches the platform. Everything else — environment
precedence, `Redacted` wrapping, error tagging, `require` — is written once
against that interface.

Resolution order is **environment variable first, credential store second**.

## Consequences

`@effect/platform-bun` does **not** wrap `Bun.secrets`; there is no such
module anywhere in Effect v4, so this wrapper is ours to maintain.

Making it a service is what puts `Secrets` in the `R` channel: the compiler
refuses to run the CLI until a layer is provided, and `layerMemory` gives
tests an isolated, env-blind store instead of writing to a developer's real
keychain.

Environment-first means a shell or CI job can override the store without
touching it. It also means that inside a project with a `.env` file, Bun
auto-loads it and the environment always wins — `keys list` will report
`(env)` and `keys set` skips those providers, which is correct but surprising
during development.

**Not every machine has a credential store.** Headless Linux, containers and
some WSL setups have no keyring daemon, and `Bun.secrets` throws
`ERR_SECRETS_PLATFORM_ERROR: libsecret not available`. CI caught this. Reads
therefore distinguish "no store at all" from "no key stored": `keys list`
falls back to environment variables and says so, rather than failing outright.
Writes still fail loudly, because silently not saving a key would be worse.

The same split applies to the `Fal` service: effectful operations that carry
dependencies live behind a service key, while pure helpers (query building,
path detection, output-path planning) stay free functions. A service earns its
ceremony by making a dependency explicit or swappable; wrapping a pure
function in one buys nothing.
