# 35. `infer serve` runs each job as a child `infer`, in its own directory

- Status: accepted
- Date: 2026-10-21

## Context

An app that wants infer's primitives — render a card, screenshot a page, run
a fal model — has to shell out to the CLI, which means installing Bun,
ffmpeg and Chrome next to it and parsing process output. A server in the
same container (or on the network) that takes the argv over HTTP removes
that, and lets the heavy dependencies live in one image.

## Decision

**One generic endpoint, `POST /v1/run {args, stdin?, files?}`, on Effect's
HttpApi, that runs `infer` itself as a child process in a fresh directory
per job.**

- **Generic, not one endpoint per command.** The argv is the contract the
  CLI already documents in `--help` and the skill, so every command is served
  the day it is added and the HTTP surface cannot drift from the CLI. Typed
  per-command endpoints can come later for a command a client uses heavily.
- **A child, not `Command.runWith` in-process.** Commands resolve paths
  against the working directory, print to `process.stdout`, and some read
  `Bun.stdin` — process-wide state that concurrent jobs would share. A child
  gets its own cwd, stdin and output; a timeout can kill it (SIGTERM, then
  SIGKILL after 10 s); a crash or a leak takes down one job. Starting one
  costs about 50 ms against renders that take seconds.
- **A directory per job.** Inputs (`files`, as text in JSON or binary in
  multipart) are written there; the answer lists every file created or
  changed, by path relative to the job, with a download URL; printed paths
  have the job directory taken out so they match. Finished jobs are deleted
  after `--keep` minutes, all of them when the server stops. A job that is
  refused or abandoned (the client disconnects) is deleted at once, and its
  child killed.
- **A failed command is a 200.** The job ran; `exitCode` and `stderr` say
  how. HTTP errors are kept for the request itself: 400 for a command that
  is not served or a path that leaves the job directory, 401 without the
  token.
- **Not served:** `meeting` and `human` need a person at this machine,
  `each` runs arbitrary programs, and `keys`, `update` and `skills` change
  the server's own machine.
- **A bearer token is mandatory**, generated and printed when none is given:
  the server spends the API keys it runs with. It binds 127.0.0.1 unless
  `--host` says otherwise. The token grants running infer as the server's
  user — paths in `args` are not confined to the job directory — so it is
  shared like an SSH key, not like an API key for a sandbox.
- **Docker image built from the bundle.** `just docker` bundles, then builds
  on `oven/bun:<the bundling Bun>-debian` with ffmpeg and Playwright's
  headless shell installed with `--with-deps` at the pinned
  `PLAYWRIGHT_VERSION` — both read from the build, so there is no new pin to
  track. One render at build time warms the package and Tailwind caches.

## Consequences

- **Bun closes a connection idle for 10 s**, and a job sends nothing until
  it is done, so the server sets `idleTimeout: 0`; the job `--timeout` is
  what bounds a request.
- **Effect's Scalar docs page inlines Scalar's 3 MB bundle** by default,
  which quadrupled `infer.js` (980 KB → 4.3 MB) and made Bun warn about a
  source map embedded in it on every run. The docs load Scalar from jsDelivr
  instead (`HttpApiScalar.layerCdn`); the server adds 137 KB.
- Multipart decoding needs `FileSystem` per request, not when the layer is
  built: `HttpRouter.toWebHandler` in tests needs it from `provideMerge`.
- The image is 1.1 GB, mostly Chrome and its libraries. Renders in it use
  Linux's fonts, so text set in the default sans-serif looks different from
  a Mac render; a composition that loads its own font is identical.
