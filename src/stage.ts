/**
 * Staging work in an isolated directory, and running processes against it.
 *
 * `render` and `ui` both bundle a TSX file in a throwaway directory, install
 * its packages there, and hand it to a child process. These are those shared
 * steps, on Effect's `FileSystem` and `ChildProcess`: the directory is removed
 * and every child killed when the enclosing scope closes — whether the work
 * succeeded, failed or was interrupted — instead of by hand-written cleanup.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Console, Data, Effect, FileSystem, type Scope, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

export class StageError extends Data.TaggedError("StageError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

/** What staging needs from the platform; `BunServices.layer` provides both. */
export type Platform =
	| FileSystem.FileSystem
	| ChildProcessSpawner.ChildProcessSpawner;

/** A fresh directory, removed when the enclosing scope closes. */
export const tempDir = (
	prefix: string,
): Effect.Effect<string, StageError, FileSystem.FileSystem | Scope.Scope> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.makeTempDirectoryScoped({ prefix });
	}).pipe(
		Effect.mapError(
			(cause) =>
				new StageError({
					reason: `Could not create a temp directory: ${cause.message}`,
				}),
		),
	);

/** Writes a text file, creating its directory first. */
export const writeFile = (
	path: string,
	contents: string,
): Effect.Effect<void, StageError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.makeDirectory(dirname(path), { recursive: true });
		yield* fs.writeFileString(path, contents);
	}).pipe(
		Effect.mapError(
			(cause) =>
				new StageError({
					reason: `Could not write ${path}: ${cause.message}`,
				}),
		),
	);

/** Reads a text file. */
export const readFile = (
	path: string,
): Effect.Effect<string, StageError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(path);
	}).pipe(
		Effect.mapError(
			(cause) =>
				new StageError({ reason: `Could not read ${path}: ${cause.message}` }),
		),
	);

/**
 * Where infer keeps what outlives a single run: the update-check cache and
 * Remotion's browser download. Follows `XDG_CACHE_HOME`, else `~/.cache`.
 */
export const cacheDir = (
	env: Record<string, string | undefined> = process.env,
): string => join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "infer");

/** How a child's stream is handled: shown live, discarded, or collected. */
export type Output = "inherit" | "ignore" | "pipe";

export interface RunOptions {
	readonly cwd?: string;
	readonly stdout?: Output;
	readonly stderr?: Output;
	readonly env?: Record<string, string | undefined>;
}

export interface RunResult {
	readonly code: number;
	/** Empty unless that stream was `pipe`. */
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Runs a command to completion.
 *
 * A non-zero exit is a result, not a failure — callers decide what it means.
 * A command that cannot be started at all, such as one not installed, fails.
 * Collected streams are drained concurrently with waiting for the exit, so a
 * chatty child can never block on a full pipe.
 */
export const run = (
	command: string,
	args: ReadonlyArray<string>,
	options: RunOptions = {},
): Effect.Effect<
	RunResult,
	StageError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const stdout = options.stdout ?? "pipe";
			const stderr = options.stderr ?? "pipe";
			const handle = yield* ChildProcess.make(command, [...args], {
				...(options.cwd ? { cwd: options.cwd } : {}),
				...(options.env ? { env: options.env } : {}),
				stdout,
				stderr,
			});
			const collect = (
				stream: Stream.Stream<Uint8Array, unknown>,
				mode: Output,
			) =>
				mode === "pipe"
					? stream.pipe(Stream.decodeText(), Stream.mkString)
					: Effect.succeed("");
			const [out, err, code] = yield* Effect.all(
				[
					collect(handle.stdout, stdout),
					collect(handle.stderr, stderr),
					handle.exitCode,
				],
				{ concurrency: "unbounded" },
			);
			return { code: Number(code), stdout: out, stderr: err };
		}),
	).pipe(
		Effect.mapError(
			(cause) =>
				new StageError({
					reason: `Could not run ${command}: ${cause instanceof Error ? cause.message : String(cause)}`,
				}),
		),
	);

/**
 * Installs packages into `dir` for real.
 *
 * Not `bun --install=fallback`: that resolves packages inside one process, and
 * the bundlers these directories are handed to — Rspack, `bun build`,
 * `Bun.serve`'s HTML bundler — read the filesystem and never see them
 * (ADRs 13, 16). Warm installs come from Bun's global cache in well under a
 * second.
 */
export const install = (
	dir: string,
	deps: ReadonlyArray<string>,
): Effect.Effect<void, StageError, Platform> =>
	Effect.gen(function* () {
		if (deps.length === 0) return;
		const fs = yield* FileSystem.FileSystem;
		const manifest = join(dir, "package.json");
		const hasManifest = yield* fs
			.exists(manifest)
			.pipe(Effect.orElseSucceed(() => false));
		if (!hasManifest) {
			yield* writeFile(manifest, JSON.stringify({ private: true }));
		}
		yield* Console.error(
			`Installing ${deps.length} package${deps.length === 1 ? "" : "s"}...`,
		);
		const result = yield* run("bun", ["install", ...deps], {
			cwd: dir,
			stdout: "ignore",
		});
		if (result.code !== 0) {
			return yield* Effect.fail(
				new StageError({
					reason: `Could not install packages:\n${result.stderr.trim()}`,
				}),
			);
		}
	});
