# 4. Resolve releases through the API, not `latest/download`

- Status: accepted
- Date: 2026-07-29

## Context

GitHub offers a permanent "latest asset" URL that needs no API call, no token
and no tag parsing:

```
https://github.com/<owner>/<repo>/releases/latest/download/infer.js
```

It is the obvious thing for both `install.sh` and `infer update` to fetch, and
it is what this project originally used.

## Decision

Do not use it. Read `tag_name` from
`https://api.github.com/repos/<owner>/<repo>/releases/latest`, then download
the immutable per-tag asset:

```
https://github.com/<owner>/<repo>/releases/download/<tag>/infer.js
```

`infer update` takes `browser_download_url` straight from the API response.
`install.sh` extracts the tag with `sed` so it needs no `jq`.

## Consequences

**That URL is CDN-cached and lags behind the release.** Immediately after
publishing v0.2.1, the API correctly reported v0.2.1 as latest while
`releases/latest/download/infer.js` still served the **v0.2.0** bundle. The
result was the worst kind of failure: `infer update` reported
`Updated to v0.2.1`, exited 0, and left v0.2.0 installed. Nothing looked
wrong. It was only caught by asserting `--version` after updating.

The cost is one extra HTTP request and a dependency on the unauthenticated API
rate limit (60 requests/hour/IP), which is irrelevant for update checks.

`raw.githubusercontent.com` caches the same way, for a few minutes. A freshly
pushed `install.sh` is *not* what `curl … | sh` fetches right away, so verify
installer changes by running the local file, not the raw URL.

Anything verifying an update must assert the resulting version. "The command
exited 0" proves nothing here.
