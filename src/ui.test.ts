import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, type FileSystem } from "effect";
import {
	buildPage,
	describeTimeout,
	flattenApp,
	newToken,
	parseServeUrl,
} from "./ui.ts";

const page = (
	overrides: Partial<Parameters<typeof buildPage>[0]> = {},
): string =>
	buildPage({
		token: "abc123",
		mode: "ask",
		title: "page.tsx",
		data: undefined,
		...overrides,
	});

describe("newToken", () => {
	test("is 16 hex characters, which is what the URL path carries", () => {
		expect(newToken()).toMatch(/^[0-9a-f]{16}$/);
	});

	test("does not repeat, since it is the only access control there is", () => {
		const seen = new Set(Array.from({ length: 200 }, () => newToken()));
		expect(seen.size).toBe(200);
	});
});

describe("buildPage", () => {
	test("hands the page its data through the JSON slot", () => {
		const html = page({ data: { posts: ["one", "two"] } });
		expect(html).toContain('<script id="infer-data" type="application/json">');
		expect(html).toContain('{"posts":["one","two"]}');
	});

	test("leaves the slot empty when no --data was given, so infer.data is null", () => {
		expect(page()).toContain(
			'<script id="infer-data" type="application/json"></script>',
		);
	});

	test("carries the token into the harness, which sends it back as a header", () => {
		expect(page({ token: "deadbeef" })).toContain('var TOKEN = "deadbeef"');
	});

	// The Done button is built by the harness at runtime from MODE, so the
	// markup for it is in the source either way — the mode is what decides.
	test("tells the harness which mode it is in, which is what adds Done", () => {
		expect(page({ mode: "present" })).toContain('var MODE = "present"');
		expect(page({ mode: "ask" })).toContain('var MODE = "ask"');
	});

	test("offers the raw escape hatch in both modes, since generated pages break", () => {
		expect(page({ mode: "ask" })).toContain('id="infer-raw-send"');
		expect(page({ mode: "present" })).toContain('id="infer-raw-send"');
	});

	test("loads the flattened bundle, not the original .tsx", () => {
		expect(page()).toContain('<script type="module" src="./app.js">');
	});

	test("runs the harness before the page module so window.infer is there", () => {
		const html = page();
		expect(html.indexOf("window.infer")).toBeLessThan(
			html.indexOf('src="./app.js"'),
		);
	});

	test("inlines Tailwind only when given, and never from a CDN", () => {
		expect(page({ tailwindScript: "var tw=1;" })).toContain(
			"<script>var tw=1;</script>",
		);
		expect(page()).not.toContain("var tw=1;");
		expect(page({ tailwindScript: "var tw=1;" })).not.toContain("cdn.");
	});

	test("appends --head after the base style so it can override it", () => {
		const html = page({ head: "<style>body{color:red}</style>" });
		expect(html.indexOf("body{color:red}")).toBeGreaterThan(
			html.indexOf("--infer-fg"),
		);
	});

	test("keeps a stray angle bracket in the title out of the markup", () => {
		expect(page({ title: "<img onerror=x>" })).toContain(
			"<title>img onerror=x></title>",
		);
	});
});

describe("parseServeUrl", () => {
	test("picks the tailnet URL out of what tailscale serve prints", () => {
		expect(
			parseServeUrl(
				"Available within your tailnet:\n\nhttps://box.tail2527fa.ts.net/\n|-- proxy http://127.0.0.1:8765\n",
			),
		).toBe("https://box.tail2527fa.ts.net");
	});

	test("keeps the port a foreground share prints", () => {
		// Each share runs on its own HTTPS port, so the port is part of the URL.
		expect(
			parseServeUrl(
				"Available within your tailnet:\n\nhttps://box.tail2527fa.ts.net:62768/\n|-- proxy http://127.0.0.1:62768\n\nPress Ctrl+C to exit.\n",
			),
		).toBe("https://box.tail2527fa.ts.net:62768");
	});

	test("returns null when sharing failed, so the caller can report it", () => {
		expect(parseServeUrl("command not found: tailscale")).toBeNull();
	});
});

describe("describeTimeout", () => {
	test("reads as a duration a person would say", () => {
		expect(describeTimeout(45_000)).toBe("45s");
		expect(describeTimeout(300_000)).toBe("5m");
		expect(describeTimeout(900_000)).toBe("15m");
	});

	test("does not round a minute and a half up to two minutes", () => {
		expect(describeTimeout(90_000)).toBe("1m30s");
	});
});

describe("flattenApp", () => {
	const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
		Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
	const dirs: string[] = [];
	const temp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "infer-ui-test-"));
		dirs.push(dir);
		return dir;
	};
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	test("reports the packages to install and inlines relative imports", async () => {
		const source = temp();
		await Bun.write(
			join(source, "card.tsx"),
			"export const Card = () => <b>hi</b>;\n",
		);
		await Bun.write(
			join(source, "app.tsx"),
			[
				'import { createRoot } from "react-dom/client";',
				'import { Card } from "./card.tsx";',
				'createRoot(document.getElementById("root")!).render(<Card />);',
			].join("\n"),
		);

		const staged = temp();
		const { deps } = await run(flattenApp(join(source, "app.tsx"), staged));

		expect([...deps].sort()).toEqual(["react", "react-dom"]);
		const bundle = await Bun.file(join(staged, "app.js")).text();
		// The relative import is gone because its contents were pulled in, which
		// is what lets a page live anywhere.
		expect(bundle).not.toContain("./card.tsx");
		expect(bundle).toContain("hi");
	});

	test("compiles JSX against the production runtime the page is served with", async () => {
		const source = temp();
		await Bun.write(
			join(source, "app.tsx"),
			'export default () => <p className="x">y</p>;\n',
		);
		const staged = temp();
		await run(flattenApp(join(source, "app.tsx"), staged));
		const bundle = await Bun.file(join(staged, "app.js")).text();

		// jsx-dev-runtime has no jsxDEV export in production, and every page would
		// die with "jsxDEV is not a function".
		expect(bundle).not.toContain("jsx-dev-runtime");
		expect(bundle).toContain("react/jsx-runtime");
	});

	test("embeds imported files and reports imported CSS", async () => {
		// A page used to lose both: an import became a path to a file the move
		// into the staged directory left behind, and CSS was dropped.
		const source = temp();
		await Bun.write(join(source, "logo.svg"), "<svg/>");
		await Bun.write(join(source, "app.css"), "p { color: red }");
		await Bun.write(
			join(source, "app.tsx"),
			'import "./app.css";\nimport logo from "./logo.svg";\nexport default () => <img src={logo} />;\n',
		);
		const staged = temp();
		const { css } = await run(flattenApp(join(source, "app.tsx"), staged));
		const bundle = await Bun.file(join(staged, "app.js")).text();

		expect(bundle).toContain("data:image/svg+xml;base64,");
		expect(css).toBe(true);
		expect(await Bun.file(join(staged, "composition.css")).text()).toContain(
			"red",
		);
	});

	test("names the missing file rather than failing inside the bundler", async () => {
		const result = await run(
			flattenApp(join(temp(), "nope.tsx"), temp()).pipe(Effect.result),
		);
		expect(result._tag).toBe("Failure");
	});
});
