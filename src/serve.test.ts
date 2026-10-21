import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpServer } from "@effect/platform-bun";
import { Duration, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import {
	inside,
	refusal,
	relativize,
	routes,
	type ServeOptions,
} from "./serve.ts";

describe("refusal", () => {
	test("lets a command or a global flag through", () => {
		expect(refusal(["render", "image", "card.tsx"])).toBeUndefined();
		expect(refusal(["--version"])).toBeUndefined();
		expect(refusal(["shot", "--help"])).toBeUndefined();
	});

	test("refuses what makes no sense remotely, saying why", () => {
		expect(refusal(["meeting"])).toContain("microphone");
		expect(refusal(["human", "ask"])).toContain("not served");
		expect(refusal(["each", "-i", "rows.jsonl", "--", "rm", "-rf"])).toContain(
			"arbitrary programs",
		);
		expect(refusal(["keys", "list"])).toContain("not served");
	});

	test("refuses an empty argv, and flags before the command", () => {
		expect(refusal([])).toContain("empty");
		// A flag taking a value would hide the command behind it.
		expect(refusal(["--log-level", "debug", "meeting"])).toContain(
			"must start with a command",
		);
	});
});

describe("inside", () => {
	test("resolves relative paths, subfolders included", () => {
		expect(inside("/jobs/a", "card.tsx")).toBe("/jobs/a/card.tsx");
		expect(inside("/jobs/a", "public/logo.png")).toBe(
			"/jobs/a/public/logo.png",
		);
	});

	test("refuses anything that leaves the directory", () => {
		expect(inside("/jobs/a", "../b/x")).toBeUndefined();
		expect(inside("/jobs/a", "sub/../../x")).toBeUndefined();
		expect(inside("/jobs/a", "/etc/passwd")).toBeUndefined();
		expect(inside("/jobs/a", ".")).toBeUndefined();
		expect(inside("/jobs/a", "")).toBeUndefined();
		// A sibling sharing the prefix is not inside.
		expect(inside("/jobs/a", "../ab/x")).toBeUndefined();
	});
});

test("relativize takes the job directory out of printed paths", () => {
	expect(relativize('{"output": "/tmp/j/1/out/a.png"}', "/tmp/j/1")).toBe(
		'{"output": "out/a.png"}',
	);
});

// A stand-in for infer: the server runs whatever script it is given, and this
// one exercises cwd, stdin, written files, failure and hanging without Chrome,
// ffmpeg or keys.
const scratch = mkdtempSync(join(tmpdir(), "infer-serve-test-"));
const fake = join(scratch, "fake.ts");
writeFileSync(
	fake,
	`const [command, ...rest] = process.argv.slice(2);
if (command === "echo") console.log(JSON.stringify({ args: rest, stdin: await Bun.stdin.text() }));
if (command === "write") { await Bun.write(rest[0], "made"); console.log(process.cwd() + "/" + rest[0]); }
if (command === "fail") { console.error("boom"); process.exit(3); }
if (command === "sleep") await Bun.sleep(20_000);
`,
);

const TOKEN = "test-token";

const serverFor = (entry: string) =>
	HttpRouter.toWebHandler(
		routes({
			port: 0,
			host: "127.0.0.1",
			token: Redacted.make(TOKEN),
			concurrency: 2,
			timeout: Duration.seconds(2),
			keep: Duration.minutes(5),
			entry,
		} satisfies ServeOptions).pipe(
			Layer.provideMerge(BunHttpServer.layerHttpServices),
		),
		{ disableLogger: true },
	);

const server = serverFor(fake);
afterAll(async () => {
	await server.dispose();
	rmSync(scratch, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
	server.handler(
		new Request(`http://infer.test${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				...(typeof init.body === "string"
					? { "content-type": "application/json" }
					: {}),
				...init.headers,
			},
		}),
	);

interface Job {
	readonly id: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly json?: unknown;
	readonly files: ReadonlyArray<{
		readonly path: string;
		readonly url: string;
	}>;
}

const runJob = async (body: unknown) => {
	const response = await call("/v1/run", {
		method: "POST",
		body: body instanceof FormData ? body : JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Job };
};

describe("the API", () => {
	test("health needs no token", async () => {
		const response = await call("/health", {}, "");
		expect(response.status).toBe(200);
	});

	test("jobs need the token", async () => {
		const response = await call(
			"/v1/run",
			{ method: "POST", body: JSON.stringify({ args: ["echo"] }) },
			"wrong",
		);
		expect(response.status).toBe(401);
	});

	test("runs the argv with stdin, and parses JSON stdout", async () => {
		const { status, body } = await runJob({
			args: ["echo", "a b", "--flag"],
			stdin: "piped",
		});
		expect(status).toBe(200);
		expect(body.exitCode).toBe(0);
		expect(body.timedOut).toBe(false);
		expect(body.json).toEqual({ args: ["a b", "--flag"], stdin: "piped" });
		expect(body.files).toEqual([]);
	});

	test("returns written files, not the inputs, with paths relative to the job", async () => {
		const { body } = await runJob({
			args: ["write", "out/result.txt"],
			files: { "in/source.tsx": "export default 1" },
		});
		expect(body.stdout.trim()).toBe("out/result.txt");
		expect(body.files.map((file) => file.path)).toEqual(["out/result.txt"]);
		const download = await call(body.files[0]?.url ?? "");
		expect(download.status).toBe(200);
		expect(await download.text()).toBe("made");

		expect(
			(await call(`/v1/jobs/${body.id}`, { method: "DELETE" })).status,
		).toBe(204);
		expect((await call(body.files[0]?.url ?? "")).status).toBe(404);
	});

	test("takes args and binary files as multipart", async () => {
		const form = new FormData();
		form.append("args", "write");
		form.append("args", "copy.bin");
		form.append("files", new Blob([new Uint8Array([0, 1, 2])]), "data/raw.bin");
		const { body } = await runJob(form);
		expect(body.exitCode).toBe(0);
		expect(body.files.map((file) => file.path)).toEqual(["copy.bin"]);
	});

	test("a failing command is a result, not an HTTP error", async () => {
		const { status, body } = await runJob({ args: ["fail"] });
		expect(status).toBe(200);
		expect(body.exitCode).toBe(3);
		expect(body.stderr).toBe("boom\n");
		expect(body.json).toBeUndefined();
	});

	test("kills a job that runs past the timeout", async () => {
		const { body } = await runJob({ args: ["sleep"] });
		expect(body.timedOut).toBe(true);
		expect(body.exitCode).toBeNull();
	});

	test("refuses commands that are not served, and paths that escape", async () => {
		const refused = await runJob({ args: ["meeting"] });
		expect(refused.status).toBe(400);
		const escaped = await runJob({
			args: ["echo"],
			files: { "../outside.txt": "x" },
		});
		expect(escaped.status).toBe(400);
	});

	test("downloads stay inside the job", async () => {
		const { body } = await runJob({ args: ["write", "a.txt"] });
		const response = await call(
			`/v1/jobs/${body.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
		);
		expect(response.status).toBe(404);
	});

	test("publishes its OpenAPI document", async () => {
		const response = await call("/openapi.json", {}, "");
		const spec = (await response.json()) as { paths: Record<string, unknown> };
		expect(Object.keys(spec.paths)).toContain("/v1/run");
	});
});

test("serves the real CLI", async () => {
	const real = serverFor(join(import.meta.dir, "main.ts"));
	try {
		const response = await real.handler(
			new Request("http://infer.test/v1/run", {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ args: ["--version"] }),
			}),
		);
		const body = (await response.json()) as {
			exitCode: number;
			stdout: string;
		};
		expect(body.exitCode).toBe(0);
		expect(body.stdout).toStartWith("infer v");
	} finally {
		await real.dispose();
	}
});
