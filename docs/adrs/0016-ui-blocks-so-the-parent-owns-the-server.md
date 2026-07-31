# 16. `infer ui` blocks, so the parent owns the server

Date: 2026-07-31

## Status

Accepted.

## Context

Every other command answers from a provider. `infer ui` answers from the user:
it serves a page they open in a browser, and returns whatever they did with it.

The CLI already had two ways to reach a person, and neither fits a decision of
any size. `keys set` prompts in the terminal, which is fine for one string. An
agent's own question tool caps out at a handful of fixed text options. Neither
can express "here are twenty drafts, keep six, reorder them, add a note" — and
that shape of question is the common one.

The awkward part is lifetime. A server that waits for a human is a process with
no natural end, and the usual answer is a daemon: background it, write a
pidfile, heartbeat from the page, exit when idle, reap orphans on the next run.
That is a lot of machinery, and every piece of it is a way to leave a stray
server holding a port.

## Decision

**The command blocks for as long as the page is open.** The URL goes to stderr,
the answer goes to stdout, and the process lives exactly as long as the
question does.

Blocking is not a limitation worked around; it is what removes the machinery.
The parent owns the child, so there is no pidfile, no heartbeat, no idle timer
and no orphan to reap. Ctrl-C ends the question. The command exiting *is* the
server stopping. A caller that needs longer than its own tool timeout can run
the command in the background — the harness problem is the caller's, and it
should not become a lifetime problem for the server.

Three decisions follow from the same reasoning:

**The page defines the payload, so nothing validates it.** The caller writes
both the page and the code that reads the answer. `infer.submit(anything)`
stores the JSON verbatim; the server only authors `status`. A widget spec or
schema language would be a third party to an agreement between two halves of
one author.

**A random token is the whole access control, and it lives in the URL path.**
The server cannot tell the user from anything else that reaches the port. The
page carries the data *and* accepts the answer, so the token guards reading as
much as writing. Putting it in the path rather than a query parameter means
Bun's router performs the check: the bundled HTML is not a value a handler can
return, so a query parameter would have meant hand-rolling the page response.

**Ports are ephemeral by default.** Two agents running `infer ui` at once must
not collide, and with no orphans there is nothing to reconnect to, so a stable
port buys nothing.

`--share` publishes through `tailscale serve` rather than binding the tailnet
address. Binding `100.x` directly works but stops loopback from working, and
exposes the listener to every network the machine is on. `serve` keeps the
process on loopback, applies tailnet ACLs, and gives HTTPS — which is not
cosmetic: a plain-IP page is not a secure context, so `navigator.clipboard` is
unavailable, and "copy this draft" is the most obvious button on a review page.
The `--bg` config lives in `tailscaled` and outlives the process, so it is
cleared on start as well as on exit; a hard kill would otherwise leave it
proxying a dead port forever.

Every page also gets two things it did not ask for: a raw-JSON textarea in the
bottom bar, and a `window.onerror` hook that POSTs to the server so page errors
print on the CLI's stderr. Page code is generated, so some of it will be
broken, and a broken page with no fallback is a hung command. Both earned their
place during development — the error hook diagnosed the JSX failure below, and
the textarea answered a deliberately broken page.

## Consequences

Two `Bun.build` details are load-bearing, and both were discovered by the page
failing rather than by reading documentation.

**`bun --install=fallback` does not help the page.** Auto-install resolves
modules *in process*; the HTML bundler behind `Bun.serve` resolves from the
filesystem, and answers `500 Build Failed` when a package is only in Bun's
in-process cache. Packages are therefore installed into the staged directory
with `bun install`, derived from the bare specifiers left in the flattened
bundle. This is the same split ADR 12 records for the video renderer, where
Rspack cannot see what Bun resolved in process — the second time it has cost a
day, which is why it is written down twice.

That mistake survived as long as it did because a stray `~/node_modules` on the
development machine contained `react`. Every early check passed for a reason
that had nothing to do with the code. A test that passes because of something
outside the repository is worse than a failing one.

**JSX must be compiled against the production runtime.** Bun emits `jsxDEV`
from `react/jsx-dev-runtime` by default; the page is served in production mode,
where React resolves that specifier to a build without the export, and every
page dies with "jsxDEV is not a function". A `NODE_ENV` define switches the
build to `jsx` from `react/jsx-runtime`. ADR 12 records the identical failure
in the video path.

Production mode is otherwise a straight win: it still bundles on demand at the
first request, and produces 178KB where development mode produces 971KB, which
matters when the page is being opened on a phone.

The cost of blocking is that a caller must choose a timeout, and a timeout is
not the same as an answer. `status: "timeout"` exits 0 — a question nobody
answered is a result worth reporting, not a crash, the same reasoning as ADR 14
for providers that cannot report a balance. The risk is that a reader skims the
status and proceeds as if approved, so the reference file states plainly that a
timeout is not consent and that `cancelled` and `timeout` mean different
things.
