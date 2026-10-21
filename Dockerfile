# infer serve in a container: every command over HTTP, for another app to
# call. Build with `just docker`, which bundles the CLI first and passes the
# Bun and Playwright versions the bundle was made for.
#
#   docker run -p 8787:8787 -e INFER_SERVE_TOKEN=... -e FAL_KEY=... infer
#
# Keys come from the environment (FAL_KEY, GROQ_API_KEY, BRIGHTDATA_API_KEY,
# OPENROUTER_API_KEY): a container has no credential store.

ARG BUN_VERSION=1
FROM oven/bun:${BUN_VERSION}-debian

ARG PLAYWRIGHT_VERSION

# ffmpeg for media and video; Chrome's headless shell, with the system
# libraries and fonts it needs, at the build infer pins, in a shared path so
# the unprivileged user below finds it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& bunx playwright-core@${PLAYWRIGHT_VERSION} install --with-deps --only-shell chromium \
	&& chmod -R a+rX /ms-playwright \
	&& rm -rf /var/lib/apt/lists/* /root/.bun/install/cache

COPY --chmod=755 dist/infer.js /usr/local/bin/infer

USER bun
WORKDIR /home/bun
# The server must not replace its own binary; a new image is the update.
ENV INFER_NO_UPDATE_CHECK=1

# One render now, so the first request does not wait on package installs and
# Tailwind's download.
RUN printf 'export default () => <div className="p-4 text-xl">warm</div>\n' > warm.tsx \
	&& infer render image warm.tsx -o warm.png \
	&& rm -rf warm.tsx warm.png out

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s \
	CMD bun -e "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["infer"]
CMD ["serve", "--host", "0.0.0.0"]
