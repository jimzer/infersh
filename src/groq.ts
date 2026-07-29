/**
 * Groq speech-to-text.
 *
 * Audio is downsampled to 16 kHz mono FLAC with ffmpeg before upload, which
 * is what Groq does server-side anyway — doing it first keeps large files
 * under the attachment limit without any loss in transcription quality.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
	Console,
	Context,
	Data,
	Effect,
	Layer,
	Option,
	Redacted,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { MissingKeyError, Secrets } from "./secrets.ts";

const TRANSCRIPTIONS_URL =
	"https://api.groq.com/openai/v1/audio/transcriptions";

export const MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const;
export const RESPONSE_FORMATS = ["json", "verbose_json", "text"] as const;
export const GRANULARITIES = ["segment", "word"] as const;

/** Formats Groq accepts, and therefore what ffmpeg is allowed to skip. */
export const SUPPORTED_EXTENSIONS = [
	".flac",
	".mp3",
	".mp4",
	".mpeg",
	".mpga",
	".m4a",
	".ogg",
	// The docs table omits opus, but the API's own rejection message lists it.
	".opus",
	".wav",
	".webm",
] as const;

/** Direct uploads are capped at 25 MB regardless of tier; larger needs --url. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class GroqError extends Data.TaggedError("GroqError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}

export interface TranscribeOptions {
	readonly file?: string;
	readonly url?: string;
	readonly model: string;
	readonly language?: string;
	readonly prompt?: string;
	readonly responseFormat?: string;
	readonly temperature?: number;
	readonly granularities: ReadonlyArray<string>;
	/** Run the ffmpeg preprocessing pass. Ignored for --url. */
	readonly optimize: boolean;
}

/**
 * Rejects combinations the API would reject, with a message that says what to
 * do instead. Pure so the rules are testable without touching the network.
 */
export const validate = (options: TranscribeOptions): string | null => {
	const hasFile = options.file !== undefined && options.file !== "";
	const hasUrl = options.url !== undefined && options.url !== "";

	if (!hasFile && !hasUrl) {
		return "Either --file or --url is required.";
	}
	if (hasFile && hasUrl) {
		return "Pass either --file or --url, not both.";
	}
	if (
		options.granularities.length > 0 &&
		options.responseFormat !== "verbose_json"
	) {
		return "--timestamp-granularities requires --response-format verbose_json.";
	}
	if (
		options.temperature !== undefined &&
		(options.temperature < 0 || options.temperature > 1)
	) {
		return "--temperature must be between 0 and 1.";
	}
	return null;
};

/** The ffmpeg invocation from the Groq docs: 16 kHz, mono, first track, FLAC. */
export const ffmpegArgs = (
	input: string,
	output: string,
): ReadonlyArray<string> => [
	"ffmpeg",
	"-i",
	input,
	"-ar",
	"16000",
	"-ac",
	"1",
	"-map",
	"0:a",
	"-c:a",
	"flac",
	"-y",
	output,
];

/** Human-readable byte count for size warnings. */
export const formatBytes = (bytes: number): string => {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
};

/** True when Groq would reject the direct upload outright. */
export const exceedsAttachmentLimit = (bytes: number): boolean =>
	bytes > MAX_ATTACHMENT_BYTES;

export const isSupportedExtension = (path: string): boolean =>
	(SUPPORTED_EXTENSIONS as ReadonlyArray<string>).includes(
		extname(path).toLowerCase(),
	);

export interface GroqShape {
	/** Transcribe an audio file or URL, returning the raw response body. */
	readonly transcribe: (
		options: TranscribeOptions,
	) => Effect.Effect<string, GroqError>;
}

export class Groq extends Context.Service<Groq, GroqShape>()("Groq") {}

const make = (options: {
	readonly http: HttpClient.HttpClient;
	readonly credentials: Option.Option<string>;
}): GroqShape => {
	const { http, credentials } = options;

	const requireCredentials = Option.isSome(credentials)
		? Effect.succeed(credentials.value)
		: Effect.fail(
				new GroqError({
					reason: new MissingKeyError({ provider: "groq" }).message,
				}),
			);

	/**
	 * Downsamples to 16 kHz mono FLAC. A missing ffmpeg is a warning rather
	 * than a failure: the original file may well be small enough already.
	 */
	const optimize = (input: string): Effect.Effect<string | null, GroqError> =>
		Effect.gen(function* () {
			const output = join(
				tmpdir(),
				`infer-${process.pid}-${basename(input, extname(input))}.flac`,
			);
			const result = yield* Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn([...ffmpegArgs(input, output)], {
						stdout: "ignore",
						stderr: "pipe",
					});
					const stderr = await new Response(proc.stderr).text();
					const code = await proc.exited;
					return { code, stderr };
				},
				catch: () => new GroqError({ reason: "__ffmpeg_missing__" }),
			}).pipe(
				Effect.catch((error) =>
					error.reason === "__ffmpeg_missing__"
						? Effect.succeed(null)
						: Effect.fail(error),
				),
			);

			if (result === null) {
				yield* Console.error(
					"ffmpeg not found — uploading the original file. Install ffmpeg, or pass --no-optimize to silence this.",
				);
				return null;
			}
			if (result.code !== 0) {
				return yield* Effect.fail(
					new GroqError({
						reason: `ffmpeg failed to preprocess ${input}:\n${result.stderr.trim().split("\n").slice(-5).join("\n")}`,
					}),
				);
			}
			return output;
		});

	const readUpload = (path: string): Effect.Effect<File, GroqError> =>
		Effect.tryPromise({
			try: async () => {
				const file = Bun.file(path);
				if (!(await file.exists())) throw new Error("file not found");
				const bytes = await file.arrayBuffer();
				// Named by basename so the extension drives Groq's format detection
				// and the full local path never leaves the machine.
				return new File([bytes], basename(path));
			},
			catch: (cause) =>
				new GroqError({ reason: `Could not read ${path}: ${cause}` }),
		});

	return {
		transcribe: (opts) =>
			Effect.gen(function* () {
				const invalid = validate(opts);
				if (invalid !== null) {
					return yield* Effect.fail(new GroqError({ reason: invalid }));
				}
				const key = yield* requireCredentials;

				let temporary: string | null = null;
				const form = new FormData();

				if (opts.url !== undefined && opts.url !== "") {
					form.append("url", opts.url);
				} else if (opts.file !== undefined) {
					let source = opts.file;
					if (opts.optimize) {
						const optimized = yield* optimize(opts.file);
						if (optimized !== null) {
							temporary = optimized;
							source = optimized;
						}
					} else if (!isSupportedExtension(opts.file)) {
						yield* Console.error(
							`${extname(opts.file) || "This file"} is not a format Groq accepts; --no-optimize skipped the conversion that would have fixed it.`,
						);
					}

					const upload = yield* readUpload(source);
					if (exceedsAttachmentLimit(upload.size)) {
						return yield* Effect.fail(
							new GroqError({
								reason: `${basename(source)} is ${formatBytes(upload.size)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} direct-upload limit.\nHost it and pass --url instead, or split it into chunks.`,
							}),
						);
					}
					form.append("file", upload);
				}

				form.append("model", opts.model);
				if (opts.language) form.append("language", opts.language);
				if (opts.prompt) form.append("prompt", opts.prompt);
				if (opts.responseFormat)
					form.append("response_format", opts.responseFormat);
				if (opts.temperature !== undefined)
					form.append("temperature", String(opts.temperature));
				for (const granularity of opts.granularities) {
					form.append("timestamp_granularities[]", granularity);
				}

				const response = yield* http
					.execute(
						HttpClientRequest.post(TRANSCRIPTIONS_URL, {
							headers: { Authorization: `Bearer ${key}` },
						}).pipe(HttpClientRequest.bodyFormData(form)),
					)
					.pipe(
						Effect.mapError(
							(cause) =>
								new GroqError({ reason: `Transcription failed: ${cause}` }),
						),
					);

				const body = yield* response.text.pipe(
					Effect.mapError(
						(cause) =>
							new GroqError({
								reason: `Could not read the response: ${cause}`,
							}),
					),
				);

				// Clean up before returning, but never let cleanup mask a result.
				if (temporary !== null) {
					try {
						unlinkSync(temporary);
					} catch {}
				}

				if (response.status >= 400) {
					return yield* Effect.fail(
						new GroqError({
							reason: `Transcription failed (${response.status}): ${body}`,
						}),
					);
				}
				return body;
			}),
	};
};

export const layer: Layer.Layer<Groq, never, Secrets | HttpClient.HttpClient> =
	Layer.effect(Groq)(
		Effect.gen(function* () {
			const secrets = yield* Secrets;
			const http = yield* HttpClient.HttpClient;
			const resolved = yield* secrets
				.get("groq")
				.pipe(Effect.orElseSucceed(Option.none));
			return make({
				http,
				credentials: Option.map(resolved, (r) => Redacted.value(r.key)),
			});
		}),
	);
