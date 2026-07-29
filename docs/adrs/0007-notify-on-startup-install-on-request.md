# 7. Notify on startup, install on request

- Status: accepted
- Date: 2026-07-29

## Context

`infer update` only helps someone who already suspects there is an update.
The obvious next step is to update automatically on startup — but a CLI that
silently rewrites itself on every invocation is hostile in ways that only show
up later.

## Decision

Check for updates **after the invoked command finishes**, at most once every
24 hours, and by default only **print a one-line notice** to stderr:

```
infer v0.3.0 is available (you have v0.2.3) — run `infer update`
```

Actually installing on startup is opt-in with `INFER_AUTO_UPDATE=1`.

The check is off entirely when any of these hold:

| Condition | Why |
| --- | --- |
| version is `dev` | a source checkout has nothing to update to |
| `INFER_NO_UPDATE_CHECK` | explicit opt-out |
| `CI` is set | CI must be reproducible and never self-modify |
| stderr is not a TTY | output is piped; a script is reading us |

`INFER_AUTO_UPDATE` still loses to `dev` and `CI`.

## Consequences

**Auto-installing on every start was rejected for three concrete reasons.**
The unauthenticated GitHub API allows 60 requests/hour/IP, which a CLI called
in a loop would exhaust and then start erroring on. Every invocation would pay
a network round-trip. And a script that worked yesterday would silently pick up
new behaviour — including breaking changes — mid-run.

The 24-hour cache means the common invocation performs **no network I/O at
all**: it reads one small JSON file. Measured at ~60 ms total for a cached run
versus a network round-trip otherwise. The cache lives at
`$XDG_CACHE_HOME/infer/update-check.json`, falling back to `~/.cache`.

**Running the check after the command, not before, is what makes this safe.**
It cannot delay the command's output, and an opt-in auto-install cannot swap
the binary while it is still doing work — the process is finished by then.
This required carrying the exit code out of the Effect program rather than
calling `process.exit` inside the error handler, which would have skipped the
check entirely.

Every failure path is silent: offline, rate-limited, timed out (1.5 s cap),
corrupt cache, or an unwritable cache directory. An update check must never be
able to break the command the user actually ran. A stale cache is preferred
over an error, and a corrupt cache file is rewritten on the next check.
