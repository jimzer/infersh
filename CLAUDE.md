Clone locally in /tmp Effect v4 that we use to explore the best apis when building with effect, always try to leverage the most the feature of Effect to elegantly fulfill requirements.

Some dependency versions are pinned in code rather than package.json (Tailwind, Playwright, Remotion, React for video). `just pins` compares them with npm and says what to check before bumping each; the `/release` skill runs it on every release. When adding a new pin, add it to `scripts/pins.ts`.

Track work in GitHub issues on jimzer/infersh. Before starting a piece of work, open an issue for it (or reuse the one that exists) describing the goal and the plan; reference it in the commits (`#N`), and close it when the work is done and verified. Ideas that are not being worked on yet get the `idea` label and stay open.
