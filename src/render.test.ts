import { describe, expect, test } from "bun:test";
import {
	ASSET_ORIGIN,
	assetPathFor,
	buildHtml,
	formatFromPath,
} from "./render.ts";

describe("formatFromPath", () => {
	test("maps the extension to a Playwright image type", () => {
		expect(formatFromPath("a.png")).toBe("png");
		expect(formatFromPath("a.webp")).toBe("webp");
		expect(formatFromPath("a.jpeg")).toBe("jpeg");
	});

	test("treats .jpg as jpeg, which Playwright does not accept", () => {
		expect(formatFromPath("a.jpg")).toBe("jpeg");
	});

	test("is case-insensitive and defaults to png", () => {
		expect(formatFromPath("a.PNG")).toBe("png");
		expect(formatFromPath("a.JPG")).toBe("jpeg");
		expect(formatFromPath("noextension")).toBe("png");
		expect(formatFromPath("a.gif")).toBe("png");
	});
});

describe("buildHtml", () => {
	const base = { markup: "<h1>hi</h1>", tailwind: false, transparent: false };

	test("points relative asset URLs at the intercepted origin", () => {
		expect(buildHtml(base)).toContain(`<base href="${ASSET_ORIGIN}/">`);
	});

	test("always resets the default body margin", () => {
		// Chrome's 8px default would otherwise show as a border on the capture.
		expect(buildHtml(base)).toContain("margin:0");
	});

	test("includes the markup and the charset", () => {
		const html = buildHtml(base);
		expect(html).toContain("<h1>hi</h1>");
		expect(html).toContain('<meta charset="utf-8">');
	});

	test("injects Tailwind only when asked", () => {
		expect(buildHtml(base)).not.toContain("tailwindcss");
		expect(buildHtml({ ...base, tailwind: true })).toContain(
			"https://cdn.tailwindcss.com",
		);
	});

	test("makes the background transparent only when asked", () => {
		expect(buildHtml(base)).not.toContain("background:transparent");
		expect(buildHtml({ ...base, transparent: true })).toContain(
			"background:transparent",
		);
	});

	test("appends extra head html after the defaults", () => {
		const html = buildHtml({ ...base, head: "<style>h1{color:red}</style>" });
		expect(html).toContain("<style>h1{color:red}</style>");
		expect(html.indexOf("<base")).toBeLessThan(html.indexOf("color:red"));
	});
});

describe("assetPathFor", () => {
	const dir = "/srv/assets";

	test("resolves a request to a file inside the asset directory", () => {
		expect(assetPathFor(`${ASSET_ORIGIN}/img/logo.png`, dir)).toBe(
			"/srv/assets/img/logo.png",
		);
	});

	test("decodes percent-encoded names", () => {
		expect(assetPathFor(`${ASSET_ORIGIN}/my%20logo.png`, dir)).toBe(
			"/srv/assets/my logo.png",
		);
	});

	test("ignores the query string", () => {
		expect(assetPathFor(`${ASSET_ORIGIN}/a.png?v=2`, dir)).toBe(
			"/srv/assets/a.png",
		);
	});

	test("plain dot segments are normalised away by URL parsing", () => {
		// The URL parser removes these during parsing, so they land harmlessly
		// inside the asset directory rather than escaping it.
		expect(assetPathFor(`${ASSET_ORIGIN}/../../etc/passwd`, dir)).toBe(
			"/srv/assets/etc/passwd",
		);
		expect(assetPathFor(`${ASSET_ORIGIN}/a/../../../etc/passwd`, dir)).toBe(
			"/srv/assets/etc/passwd",
		);
	});

	test("an encoded slash smuggles traversal past the parser; the guard stops it", () => {
		// A bare %2e%2e is recognised as a dot segment and normalised away, but
		// %2f hides the separator, so the whole thing stays one opaque segment
		// that decoding turns back into ../../. Without the containment check
		// this request would serve /etc/passwd.
		expect(assetPathFor(`${ASSET_ORIGIN}/%2e%2e/secret`, dir)).toBe(
			"/srv/assets/secret",
		);
		expect(
			assetPathFor(`${ASSET_ORIGIN}/%2e%2e%2f%2e%2e%2fetc/passwd`, dir),
		).toBeNull();
		expect(
			assetPathFor(`${ASSET_ORIGIN}/..%2f..%2fetc/passwd`, dir),
		).toBeNull();
	});

	test("no input resolves outside the asset directory", () => {
		for (const suspicious of [
			"/../../etc/passwd",
			"/%2e%2e%2f%2e%2e%2fetc/passwd",
			"/%252e%252e/x",
			"/a/./../../b",
			"/....//....//etc/passwd",
		]) {
			const resolved = assetPathFor(`${ASSET_ORIGIN}${suspicious}`, dir);
			if (resolved !== null) {
				expect(resolved.startsWith(`${dir}/`)).toBe(true);
			}
		}
	});

	test("allows a path that merely traverses and comes back", () => {
		expect(assetPathFor(`${ASSET_ORIGIN}/img/../img/logo.png`, dir)).toBe(
			"/srv/assets/img/logo.png",
		);
	});

	test("returns null for a malformed url", () => {
		expect(assetPathFor("not a url", dir)).toBeNull();
	});
});
