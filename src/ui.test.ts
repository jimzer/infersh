import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
	buildPage,
	describeTimeout,
	escapeForScript,
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
		tailwind: false,
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

describe("escapeForScript", () => {
	test("neutralises a closing tag hidden in the data", () => {
		const json = JSON.stringify({ post: "</script><script>alert(1)</script>" });
		const escaped = escapeForScript(json);
		expect(escaped).not.toContain("</script>");
		expect(JSON.parse(escaped).post).toBe("</script><script>alert(1)</script>");
	});

	test("leaves ordinary JSON parseable", () => {
		expect(JSON.parse(escapeForScript(JSON.stringify({ a: 1 })))).toEqual({
			a: 1,
		});
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

	test("includes Tailwind only when asked", () => {
		expect(page({ tailwind: true })).toContain("cdn.tailwindcss.com");
		expect(page({ tailwind: false })).not.toContain("cdn.tailwindcss.com");
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
		const deps = await Effect.runPromise(
			flattenApp(join(source, "app.tsx"), staged),
		);

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
		await Effect.runPromise(flattenApp(join(source, "app.tsx"), staged));
		const bundle = await Bun.file(join(staged, "app.js")).text();

		// jsx-dev-runtime has no jsxDEV export in production, and every page would
		// die with "jsxDEV is not a function".
		expect(bundle).not.toContain("jsx-dev-runtime");
		expect(bundle).toContain("react/jsx-runtime");
	});

	test("names the missing file rather than failing inside the bundler", async () => {
		const result = await Effect.runPromise(
			flattenApp(join(temp(), "nope.tsx"), temp()).pipe(Effect.result),
		);
		expect(result._tag).toBe("Failure");
	});
});
