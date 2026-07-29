# 3. Ship a single-file Bun bundle

- Status: accepted
- Date: 2026-07-29

## Context

This is a personal CLI that needs to be installable on a new machine in one
command and updatable without ceremony. Publishing to npm, or cross-compiling
a binary per platform, is more machinery than the problem deserves.

## Decision

`just bundle` runs `bun build src/main.ts --target=bun --minify` into a single
`dist/infer.js` (~430 KB). It carries a `#!/usr/bin/env bun` shebang, so it is
directly executable and needs nothing installed but Bun itself. That one file
is the release artifact, attached to every GitHub release.

The version is stamped at build time with
`bun build --define __VERSION__='"1.2.3"'`, read through:

```ts
declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
```

## Consequences

**Do not pass `--banner="#!/usr/bin/env bun"`.** Bun already carries the
shebang over from `src/main.ts` and adds a `// @bun` marker, so a banner puts
a *second* shebang on line 3 — where a shebang is a syntax error. The bundle
will not start at all. This is the opposite of the usual advice, which assumes
an entrypoint without its own shebang.

The `typeof` guard matters: without a `--define`, the identifier is undefined,
and `typeof` is the only reference to an undeclared binding that does not
throw. Source runs therefore report `dev`, which is what `infer update` keys
off to refuse to overwrite a checkout.

Because the git tag is the source of truth for a release, the release workflow
stamps the bundle from `GITHUB_REF_NAME` rather than package.json, then asserts
the built binary reports that exact version before attaching it. A drift
between tag and artifact fails the release instead of shipping.

Users need Bun on their PATH. That is an acceptable trade for skipping a
per-platform build matrix.
