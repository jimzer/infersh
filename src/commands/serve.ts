/**
 * `infer serve` — every command over HTTP.
 */

import { Console, Duration, Effect, Option, Redacted } from "effect";
import { Command, Flag } from "effect/cli";

import { serve } from "../serve.ts";
import { newToken } from "../ui.ts";

export const serveCmd = Command.make(
	"serve",
	{
		port: Flag.Int("port").pipe(
			Flag.withAlias("p"),
			Flag.withMetavar("n"),
			Flag.withDefault(8787),
			Flag.withDescription("Port to listen on. 0 picks a free one."),
		),
		host: Flag.String("host").pipe(
			Flag.withMetavar("address"),
			Flag.withDefault("127.0.0.1"),
			Flag.withDescription(
				"Address to listen on. The default only accepts this machine; use 0.0.0.0 in a container or to accept the network.",
			),
		),
		token: Flag.String("token").pipe(
			Flag.withMetavar("secret"),
			Flag.optional,
			Flag.withDescription(
				"Bearer token clients must send. Defaults to INFER_SERVE_TOKEN; without either, one is generated and printed.",
			),
		),
		concurrency: Flag.Int("concurrency").pipe(
			Flag.withMetavar("n"),
			Flag.withDefault(2),
			Flag.withDescription(
				"Jobs running at once; later ones wait. Each render starts a Chrome, so keep it low on a small machine.",
			),
		),
		timeout: Flag.Finite("timeout").pipe(
			Flag.withMetavar("minutes"),
			Flag.withDefault(30),
			Flag.withDescription("A job running longer than this is killed."),
		),
		keep: Flag.Finite("keep").pipe(
			Flag.withMetavar("minutes"),
			Flag.withDefault(60),
			Flag.withDescription(
				"How long a finished job's files stay downloadable before they are deleted.",
			),
		),
	},
	(config) =>
		Effect.gen(function* () {
			const given = Option.orElse(config.token, () =>
				Option.fromNullishOr(process.env.INFER_SERVE_TOKEN || undefined),
			);
			const token = Option.getOrElse(given, newToken);
			if (Option.isNone(given))
				yield* Console.error(
					`  token:  ${token}  (generated; set INFER_SERVE_TOKEN or --token to keep one)`,
				);
			return yield* serve({
				port: config.port,
				host: config.host,
				token: Redacted.make(token),
				concurrency: Math.max(1, config.concurrency),
				timeout: Duration.minutes(config.timeout),
				keep: Duration.minutes(config.keep),
				entry: Bun.main,
			});
		}),
).pipe(
	Command.withShortDescription(
		"Serve every command over HTTP, for an app or container.",
	),
	Command.withDescription(
		`Start an HTTP server that runs infer commands for other programs: an
app in the same container, a service on the network, anything that can
POST JSON. Runs until Ctrl-C.

One endpoint runs any command, given the argv a terminal would have used:

  POST /v1/run   {"args": ["render", "image", "card.tsx", "--json"],
                  "files": {"card.tsx": "export default () => <div/>"},
                  "stdin": "..."}
  →              {"id", "exitCode", "timedOut", "stdout", "stderr",
                  "json", "files": [{"path", "size", "url"}]}

Each job runs in a fresh directory: "files" are written there first
(binary files go as multipart instead), the command runs there, and every
file it creates is listed with a URL to download it. "json" is stdout
parsed, when it is JSON — pass --json in args for that. A non-zero
exitCode is still a 200: the job ran, and stderr says why it failed.

  GET    /v1/jobs/{id}/file?path=card.png    download an output
  DELETE /v1/jobs/{id}                       delete a job's files now
  GET    /health                             no token needed
  GET    /docs, /openapi.json                the API, browsable

Every request but /health and the docs needs Authorization: Bearer
<token>. The server spends your API keys, so keep the token secret and
the default 127.0.0.1 unless you mean to share it.

Not served, because they make no sense remotely: meeting, human, each,
keys, update, skills. Keys come from the server's credential store or its
environment (FAL_KEY, GROQ_API_KEY, ...), as for any command.`,
	),
	Command.withExamples([
		{
			command: "infer serve",
			description: "Serve on http://127.0.0.1:8787 with a generated token",
		},
		{
			command: "INFER_SERVE_TOKEN=secret infer serve --host 0.0.0.0",
			description: "In a container, reachable from other containers",
		},
		{
			command: `curl -s localhost:8787/v1/run -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"args":["shot","example.com","--json"]}'`,
			description: "Screenshot a page and get the image's URL back",
		},
		{
			command: `curl -s localhost:8787/v1/run -H "Authorization: Bearer $TOKEN" -F args=media -F args=frames -F args=clip.mp4 -F files=@clip.mp4`,
			description: "Send a binary input as multipart",
		},
	]),
);
