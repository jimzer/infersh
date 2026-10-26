/**
 * `infer serve` — the CLI over HTTP, for an app that wants infer's primitives
 * without shelling out, typically with both in one container.
 *
 * One generic endpoint rather than one per command: a job is the argv a
 * terminal would have run, so every command is served the day it is added
 * and the HTTP surface cannot drift from the CLI's. Each job runs `infer`
 * itself as a child process, in a directory of its own (ADR 35): commands
 * resolve paths against the working directory and print to stdout, so a
 * child gives every job its own cwd, stdin and output, a timeout that can
 * kill it, and a crash that takes down that job alone.
 */

import { timingSafeEqual } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";

import { BunHttpServer } from "@effect/platform-bun";
import {
	Clock,
	Console,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Ref,
	Schedule,
	Schema,
	Semaphore,
} from "effect";
import {
	HttpPlatform,
	HttpRouter,
	HttpServer,
	HttpServerResponse,
	Multipart,
} from "effect/http";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiScalar,
	HttpApiSchema,
	HttpApiSecurity,
	OpenApi,
} from "effect/http-api";
import { ChildProcessSpawner } from "effect/process";

import { JsonText } from "./json.ts";
import { run } from "./stage.ts";
import { VERSION } from "./version.ts";

/** Commands a server does not run, and why: the reason is the 400's message. */
export const NOT_SERVED: Readonly<Record<string, string>> = {
	meeting: "records this machine's microphone and speakers",
	human: "waits for a person to answer in a browser",
	each: "runs arbitrary programs; call /v1/run once per row instead",
	keys: "manages the server's own API keys",
	update: "replaces the server's own binary",
	skills: "installs agent skills on the server's machine",
	serve: "is the server",
};

const GLOBAL_FLAGS = new Set(["--help", "-h", "--version"]);

/** Why an argv cannot run here, or undefined when it can. */
export const refusal = (args: ReadonlyArray<string>): string | undefined => {
	const [first] = args;
	if (first === undefined)
		return 'args is empty: pass the command line without the leading infer, e.g. ["render", "image", "card.tsx"].';
	if (first.startsWith("-"))
		return GLOBAL_FLAGS.has(first)
			? undefined
			: `args must start with a command, not ${first}.`;
	const reason = NOT_SERVED[first];
	return reason === undefined
		? undefined
		: `infer ${first} is not served: it ${reason}.`;
};

/** A client's relative path resolved inside `dir`, or undefined if it escapes. */
export const inside = (dir: string, path: string): string | undefined => {
	if (path === "" || isAbsolute(path) || path.includes("\0")) return undefined;
	const full = resolve(dir, path);
	return full.startsWith(dir + sep) ? full : undefined;
};

// ---------------------------------------------------------------------------
// The API

const Args = Schema.Array(Schema.String).annotate({
	description:
		'The command line without the leading `infer`, one element per argument: ["render", "image", "card.tsx", "--json"].',
});

const Stdin = Schema.String.annotate({
	description: "Text written to the command's stdin. Empty when omitted.",
});

const RunJson = Schema.Struct({
	args: Args,
	stdin: Schema.optionalKey(Stdin),
	files: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.String).annotate({
			description:
				'Text files written into the job directory before it runs, by relative path: {"card.tsx": "export default ..."}. Send binary files as multipart.',
		}),
	),
});

const RunMultipart = Schema.Struct({
	args: Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
		description:
			"One field per argument, repeated in order: -F args=render -F args=image -F args=card.tsx.",
	}),
	stdin: Schema.optionalKey(Stdin),
	files: Schema.optionalKey(
		Multipart.FilesSchema.annotate({
			description:
				"Files written into the job directory before it runs, under their file name, which may include subfolders: -F 'files=@logo.png;filename=public/logo.png'.",
		}),
	),
}).pipe(HttpApiSchema.asMultipart());

const OutputFile = Schema.Struct({
	path: Schema.String,
	size: Schema.Number,
	url: Schema.String,
});

export const RunResult = Schema.Struct({
	id: Schema.String,
	exitCode: Schema.NullOr(Schema.Number).annotate({
		description: "null when the job was killed for running too long.",
	}),
	timedOut: Schema.Boolean,
	stdout: Schema.String,
	stderr: Schema.String,
	json: Schema.optionalKey(
		Schema.Unknown.annotate({
			description: "stdout parsed, when it is JSON — as it is with --json.",
		}),
	),
	files: Schema.Array(OutputFile).annotate({
		description:
			"Files the command created or changed in the job directory, downloadable until the job expires.",
	}),
});

export class BadRequest extends Schema.TaggedError<BadRequest>()(
	"BadRequest",
	{ message: Schema.String },
	{ httpApiStatus: 400 },
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	"Unauthorized",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
	"NotFound",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

export class Auth extends HttpApiMiddleware.Service<Auth>()(
	"infer/serve/Auth",
	{
		security: { bearer: HttpApiSecurity.bearer },
		error: Unauthorized,
	},
) {}

const JobId = { id: Schema.String };

export class ServeApi extends HttpApi.make("infer")
	.add(
		HttpApiGroup.make("jobs")
			.add(
				HttpApiEndpoint.post("run", "/v1/run", {
					payload: [RunJson, RunMultipart],
					success: RunResult,
					error: BadRequest,
				}).annotate(
					OpenApi.Description,
					"Runs one infer command in a fresh directory and returns its exit code, output and the files it wrote. Waits for the command to finish.",
				),
				HttpApiEndpoint.get("file", "/v1/jobs/:id/file", {
					params: JobId,
					query: { path: Schema.String },
					success: HttpApiSchema.StreamUint8Array(),
					error: NotFound,
				}).annotate(OpenApi.Description, "Downloads a file a job wrote."),
				HttpApiEndpoint.delete("remove", "/v1/jobs/:id", {
					params: JobId,
					success: HttpApiSchema.NoContent,
					error: NotFound,
				}).annotate(
					OpenApi.Description,
					"Deletes a job's directory now rather than when it expires.",
				),
			)
			.middleware(Auth),
	)
	.add(
		HttpApiGroup.make("system").add(
			HttpApiEndpoint.get("health", "/health", {
				success: Schema.Struct({ version: Schema.String }),
			}),
		),
	)
	.annotateMerge(
		OpenApi.annotations({
			title: "infer",
			version: VERSION,
			description:
				"Every infer command over HTTP. Authenticate with the server's token as a bearer token.",
		}),
	) {}

// ---------------------------------------------------------------------------
// The server

export interface ServeOptions {
	readonly port: number;
	readonly host: string;
	readonly token: Redacted.Redacted<string>;
	/** Jobs running at once; the rest wait their turn. */
	readonly concurrency: number;
	/** A job running longer is killed. */
	readonly timeout: Duration.Duration;
	/** How long a finished job's files stay downloadable. */
	readonly keep: Duration.Duration;
	/** The script a job runs with Bun: this CLI's own entry point. */
	readonly entry: string;
}

const sameToken = (given: string, expected: string): boolean => {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};

const authLayer = (token: Redacted.Redacted<string>) =>
	Layer.succeed(Auth)({
		bearer: (httpEffect, { credential }) =>
			sameToken(Redacted.value(credential), Redacted.value(token))
				? httpEffect
				: Effect.fail(
						new Unauthorized({
							message:
								"Missing or wrong token: send Authorization: Bearer <token>.",
						}),
					),
	});

/** A job's inputs, whichever way they were sent. */
interface JobInput {
	readonly args: ReadonlyArray<string>;
	readonly stdin: string | undefined;
	readonly texts: ReadonlyArray<readonly [path: string, contents: string]>;
	readonly uploads: ReadonlyArray<readonly [path: string, from: string]>;
}

const jobInput = (
	payload: typeof RunJson.Type | typeof RunMultipart.Type,
): JobInput => {
	const { files } = payload;
	return {
		args: typeof payload.args === "string" ? [payload.args] : payload.args,
		stdin: payload.stdin,
		texts:
			files === undefined || Array.isArray(files)
				? []
				: Object.entries(files as Record<string, string>),
		uploads: Array.isArray(files)
			? (files as ReadonlyArray<Multipart.PersistedFile>).map(
					(file) => [file.name, file.path] as const,
				)
			: [],
	};
};

/**
 * Output with the job directory taken out of paths, so they read as the
 * paths in `files` — out/image.png — rather than the server's temp dir.
 */
export const relativize = (text: string, dir: string): string =>
	text.replaceAll(`${dir}${sep}`, "");

/** Every file under `dir` by relative path, with what tells a change apart. */
const listFiles = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* fs.readDirectory(dir, { recursive: true });
		const entries = yield* Effect.forEach(
			paths.filter((path) => !path.split(sep).includes("node_modules")),
			(path) =>
				fs.stat(join(dir, path)).pipe(
					Effect.map((info) =>
						info.type === "File"
							? Option.some({
									path,
									size: Number(info.size),
									stamp: `${info.size}:${Option.getOrElse(
										Option.map(info.mtime, (date) => date.getTime()),
										() => 0,
									)}`,
								})
							: Option.none(),
					),
				),
			{ concurrency: 16 },
		);
		return entries.flatMap((entry) => Option.toArray(entry));
	});

const jobsLayer = (options: ServeOptions) =>
	HttpApiBuilder.group(
		ServeApi,
		"jobs",
		Effect.fn(function* (handlers) {
			const fs = yield* FileSystem.FileSystem;
			// Resolved, because that is the path a child sees as its cwd and
			// prints: on macOS the temp dir is a symlink into /private.
			const root = yield* fs.realPath(
				yield* fs.makeTempDirectoryScoped({ prefix: "infer-serve-" }),
			);
			// Taken once here, so a request needs nothing from its own context.
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const platform = yield* HttpPlatform.HttpPlatform;
			const slots = yield* Semaphore.make(options.concurrency);
			// Finished jobs by id, with when they finished. A running job is not
			// here, so its files cannot be fetched half-written.
			const finished = yield* Ref.make(new Map<string, number>());

			const removeJob = (id: string) =>
				Ref.update(finished, (jobs) => {
					const next = new Map(jobs);
					next.delete(id);
					return next;
				}).pipe(
					Effect.andThen(fs.remove(join(root, id), { recursive: true })),
					Effect.ignore,
				);

			yield* Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const expired = [...(yield* Ref.get(finished))].filter(
					([, at]) => now - at > Duration.toMillis(options.keep),
				);
				yield* Effect.forEach(expired, ([id]) => removeJob(id), {
					discard: true,
				});
			}).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

			// The child must not auto-update the binary the server runs, and has
			// no use for the server's token.
			const { INFER_SERVE_TOKEN: _, ...env } = process.env;
			const childEnv = { ...env, INFER_NO_UPDATE_CHECK: "1" };

			const runJob = (input: JobInput, id: string, dir: string) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(dir);
					for (const [path, contents] of input.texts) {
						const target = inside(dir, path);
						if (target === undefined)
							return yield* new BadRequest({
								message: `files: ${path} is not a relative path inside the job directory.`,
							});
						yield* fs.makeDirectory(join(target, ".."), { recursive: true });
						yield* fs.writeFileString(target, contents);
					}
					for (const [path, from] of input.uploads) {
						const target = inside(dir, path);
						if (target === undefined)
							return yield* new BadRequest({
								message: `files: ${path} is not a relative path inside the job directory.`,
							});
						yield* fs.makeDirectory(join(target, ".."), { recursive: true });
						yield* fs.copyFile(from, target);
					}
					const before = new Map(
						(yield* listFiles(dir)).map((file) => [file.path, file.stamp]),
					);
					const started = yield* Clock.currentTimeMillis;
					const result = yield* slots.withPermits(1)(
						run(process.execPath, [options.entry, ...input.args], {
							cwd: dir,
							env: childEnv,
							...(input.stdin === undefined
								? { stdin: "ignore" as const }
								: { input: input.stdin }),
							forceKillAfter: "10 seconds",
						}).pipe(
							Effect.timeoutOption(options.timeout),
							Effect.provideService(
								ChildProcessSpawner.ChildProcessSpawner,
								spawner,
							),
						),
					);
					const after = yield* listFiles(dir);
					const ended = yield* Clock.currentTimeMillis;
					const seconds = (ended - started) / 1000;
					yield* Ref.update(finished, (jobs) => new Map(jobs).set(id, ended));
					const stdout = Option.match(result, {
						onNone: () => "",
						onSome: (done) => relativize(done.stdout, dir),
					});
					const json =
						stdout.trim() === ""
							? Option.none()
							: Schema.decodeUnknownOption(JsonText)(stdout);
					yield* Console.error(
						`${id.slice(0, 8)} infer ${input.args.join(" ")} → ${Option.match(
							result,
							{
								onNone: () => "killed: timed out",
								onSome: (done) => `exit ${done.code}`,
							},
						)} in ${seconds.toFixed(1)}s`,
					);
					return {
						id,
						exitCode: Option.match(result, {
							onNone: () => null,
							onSome: (done) => done.code,
						}),
						timedOut: Option.isNone(result),
						stdout,
						stderr: Option.match(result, {
							onNone: () =>
								`Killed after ${Duration.format(options.timeout)}: raise the server's --timeout for longer jobs.`,
							onSome: (done) => relativize(done.stderr, dir),
						}),
						...Option.match(json, {
							onNone: () => ({}),
							onSome: (value) => ({ json: value }),
						}),
						files: after
							.filter((file) => before.get(file.path) !== file.stamp)
							.map((file) => ({
								path: file.path,
								size: file.size,
								url: `/v1/jobs/${id}/file?path=${encodeURIComponent(file.path)}`,
							})),
					};
				});

			return handlers
				.handle("run", ({ payload }) => {
					const input = jobInput(payload);
					const why = refusal(input.args);
					if (why !== undefined)
						return Effect.fail(new BadRequest({ message: why }));
					const id = crypto.randomUUID();
					const dir = join(root, id);
					return runJob(input, id, dir).pipe(
						// A refused or abandoned job leaves nothing behind; a finished
						// one stays until it expires.
						Effect.onExit((exit) =>
							Exit.isSuccess(exit)
								? Effect.void
								: fs.remove(dir, { recursive: true }).pipe(Effect.ignore),
						),
						Effect.catchTag("PlatformError", Effect.die),
						Effect.catchTag("StageError", Effect.die),
					);
				})
				.handle("file", ({ params, query }) =>
					Effect.gen(function* () {
						const known = (yield* Ref.get(finished)).has(params.id);
						const path = known
							? inside(join(root, params.id), query.path)
							: undefined;
						const isFile =
							path !== undefined &&
							(yield* fs.stat(path).pipe(
								Effect.map((info) => info.type === "File"),
								Effect.orElseSucceed(() => false),
							));
						if (path === undefined || !isFile)
							return yield* new NotFound({
								message: `No file ${query.path} in job ${params.id}; jobs expire after ${Duration.format(options.keep)}.`,
							});
						return yield* HttpServerResponse.file(path).pipe(
							Effect.provideService(HttpPlatform.HttpPlatform, platform),
							Effect.orDie,
						);
					}),
				)
				.handle("remove", ({ params }) =>
					Effect.gen(function* () {
						if (!(yield* Ref.get(finished)).has(params.id))
							return yield* new NotFound({
								message: `No job ${params.id}.`,
							});
						yield* removeJob(params.id);
					}),
				);
		}),
	);

const systemLayer = HttpApiBuilder.group(ServeApi, "system", (handlers) =>
	Effect.succeed(
		handlers.handle("health", () => Effect.succeed({ version: VERSION })),
	),
);

/** Every route: the API, its OpenAPI document and the docs page. */
export const routes = (options: ServeOptions) =>
	Layer.mergeAll(
		HttpApiBuilder.layer(ServeApi, { openapiPath: "/openapi.json" }).pipe(
			Layer.provide([jobsLayer(options), systemLayer]),
			Layer.provide(authLayer(options.token)),
		),
		// Loaded from the CDN: the inline copy is 3 MB, four times the rest of
		// the CLI, for a page only a person browsing the API opens.
		HttpApiScalar.layerCdn(ServeApi, { path: "/docs" }),
	);

/** The server, until interrupted. */
export const serve = (options: ServeOptions) =>
	Layer.launch(
		HttpRouter.serve(routes(options), {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.merge(
				Layer.effectDiscard(
					HttpServer.addressFormattedWith((url) =>
						Console.error(
							`infer serve on ${url}\n  docs:   ${url}/docs\n  run:    POST ${url}/v1/run with Authorization: Bearer <token>`,
						),
					),
				),
			),
			Layer.provide(
				BunHttpServer.layer({
					port: options.port,
					hostname: options.host,
					// Bun closes a connection idle for 10 s by default, and a render
					// sends nothing until it is done.
					idleTimeout: 0,
					maxRequestBodySize: 1024 * 1024 * 1024,
				}),
			),
		),
	);
