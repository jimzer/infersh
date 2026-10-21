# infer serve

Runs an HTTP server where another program — an app, a backend, a container
next door — runs infer commands by POSTing the argv it would have typed. For
your own work, call the CLI directly; this is for wiring infer into something
else.

```bash
INFER_SERVE_TOKEN=secret infer serve                  # http://127.0.0.1:8787
INFER_SERVE_TOKEN=secret infer serve --host 0.0.0.0   # reachable from the network or other containers
just docker && docker run -p 8787:8787 -e INFER_SERVE_TOKEN=secret -e FAL_KEY=... infer   # from the repo
```

```bash
curl -s localhost:8787/v1/run -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"args":["render","image","card.tsx","--json"],"files":{"card.tsx":"export default () => <div className=\"p-8\">Hi</div>"}}'
# → {"id", "exitCode": 0, "timedOut": false, "stdout", "stderr", "json": {...},
#    "files": [{"path": "out/image.png", "size": 7701, "url": "/v1/jobs/<id>/file?path=out%2Fimage.png"}]}
curl -s -H "Authorization: Bearer $TOKEN" "localhost:8787/v1/jobs/<id>/file?path=out%2Fimage.png" -o card.png
```

- **`args` is the command line without `infer`**, one element per argument —
  no shell, so no quoting. Put `--json` in it to get `json`: stdout parsed.
- **Each job runs in a fresh directory.** `files` (name → text) is written
  there first; binary inputs go as multipart instead (`-F args=media -F
  args=info -F args=clip.mp4 -F files=@clip.mp4`, each `args` field one
  argument, in order). Paths in the command are relative to that directory,
  and paths it prints are made relative to it too.
- **`files` in the answer is what the command created or changed**, each with
  a URL that needs the same token. Jobs are deleted after `--keep` minutes
  (default 60), or at once with `DELETE /v1/jobs/<id>`.
- **A failed command is still HTTP 200** with a non-zero `exitCode` and the
  reason in `stderr`. 400 means the request itself was refused: a command
  that is not served, or a file path outside the job directory.
- **Not served:** `meeting`, `human`, `each`, `keys`, `update`, `skills`.
  To run something per row, call `/v1/run` once per row.
- **The request waits for the command.** Long renders are fine (no idle
  timeout); a job past `--timeout` minutes (default 30) is killed and comes
  back with `timedOut: true`. `--concurrency` (default 2) jobs run at once,
  the rest queue — each render starts a Chrome.
- **The token is mandatory**: the server spends the keys it runs with.
  Without `--token` or `INFER_SERVE_TOKEN` one is generated and printed on
  stderr. Keys resolve as for any command — in a container, from env vars.
- `GET /docs` is a browsable API reference, `/openapi.json` the OpenAPI
  document (for generating a typed client), `/health` needs no token.
