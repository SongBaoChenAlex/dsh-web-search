import { describe, it, expect } from "vitest";
import { shapeSearchValue, resolveCaps, DEFAULT_CAPS } from "../lib/shape.js";

const src = (url, extra = {}) => ({ url, title: "T", snippet: "s", ...extra });

describe("shapeSearchValue", () => {
	it("dedupes by cleaned url and strips tracking params", () => {
		const { value, stats } = shapeSearchValue({
			sources: [
				src("https://Example.com/a?utm_source=x&id=1"),
				src("https://example.com/a?id=1&fbclid=zzz"),
				src("https://example.com/b#frag"),
			],
			truncated: false,
		});
		expect(value.sources.map((s) => s.url)).toEqual(["https://example.com/a?id=1", "https://example.com/b"]);
		expect(stats.sourcesBefore).toBe(3);
		expect(stats.sourcesAfter).toBe(2);
		expect(value.truncated).toBe(false);
	});

	it("keeps tracking params when stripTrackingParams=false but still dedupes on them", () => {
		const { value } = shapeSearchValue({
			sources: [src("https://example.com/a?utm_source=x"), src("https://example.com/a?utm_source=y")],
			truncated: false,
		}, { stripTrackingParams: false });
		expect(value.sources).toHaveLength(1);
		expect(value.sources[0].url).toContain("utm_source=x");
	});

	it("caps snippet and content, cleans html in snippets", () => {
		const long = "word ".repeat(200);
		const { value } = shapeSearchValue({
			content: "A".repeat(100),
			sources: [src("https://e.com/1", { snippet: `<strong>hi</strong>&amp; ${long}` })],
			truncated: false,
		}, { snippetMaxChars: 50, contentMaxChars: 20 });
		expect(value.sources[0].snippet.length).toBeLessThanOrEqual(50);
		expect(value.sources[0].snippet.startsWith("hi& ")).toBe(true);
		expect(value.sources[0].snippet.endsWith("…")).toBe(true);
		expect(value.content.length).toBeLessThanOrEqual(20);
	});

	it("caps source count and sets truncated", () => {
		const sources = Array.from({ length: 8 }, (_, i) => src(`https://e.com/${i}`));
		const { value } = shapeSearchValue({ sources, truncated: false }, { maxSources: 5 });
		expect(value.sources).toHaveLength(5);
		expect(value.truncated).toBe(true);
	});

	it("does not set truncated when nothing was dropped; 0 = unlimited", () => {
		const sources = Array.from({ length: 8 }, (_, i) => src(`https://e.com/${i}`));
		const { value } = shapeSearchValue({ sources, truncated: false }, { maxSources: 0, snippetMaxChars: 0 });
		expect(value.sources).toHaveLength(8);
		expect(value.truncated).toBe(false);
	});

	it("drops absent optional fields and keeps publishedAt", () => {
		const { value } = shapeSearchValue({ sources: [{ url: "https://e.com", publishedAt: "2024-01-01" }], truncated: false });
		expect(value.sources[0]).toEqual({ url: "https://e.com", publishedAt: "2024-01-01" });
		expect(Object.hasOwn(value, "content")).toBe(false);
	});

	it("passes odd input through untouched", () => {
		expect(shapeSearchValue("nope").value).toBe("nope");
		expect(shapeSearchValue(null).value).toBe(null);
		expect(shapeSearchValue({ foo: 1 }).value).toEqual({ foo: 1 });
	});

	it("reports stats with chars/tokens before >= after", () => {
		const { stats } = shapeSearchValue({ content: "x".repeat(5000), sources: [src("https://e.com")], truncated: false });
		expect(stats.charsAfter).toBeLessThan(stats.charsBefore);
		expect(stats.tokensAfter).toBeLessThan(stats.tokensBefore);
	});
});

describe("resolveCaps", () => {
	it("applies provider override over base over defaults", () => {
		const caps = resolveCaps({ maxSources: 3 }, { tavily: { snippetMaxChars: 800 } }, "tavily");
		expect(caps).toEqual({ ...DEFAULT_CAPS, maxSources: 3, snippetMaxChars: 800 });
	});
	it("ignores overrides for a different / missing provider", () => {
		expect(resolveCaps({}, { tavily: { snippetMaxChars: 800 } }, "brave").snippetMaxChars).toBe(300);
		expect(resolveCaps({}, { tavily: { snippetMaxChars: 800 } }, undefined).snippetMaxChars).toBe(300);
	});
	it("ignores undefined keys in layers", () => {
		expect(resolveCaps({ maxSources: undefined }, undefined, undefined).maxSources).toBe(5);
	});
});
