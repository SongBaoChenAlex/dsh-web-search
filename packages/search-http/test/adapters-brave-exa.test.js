import { describe, it, expect } from "vitest";
import { brave } from "../lib/adapters/brave.js";
import { exa } from "../lib/adapters/exa.js";
import { adapters, getAdapter, catalog } from "../lib/adapter.js";
import { Config } from "../lib/index.js";

const opts = { apiKey: "k", baseURL: "", maxResults: 5, userAgent: "ua" };

describe("registry", () => {
	it("knows tavily, brave, exa, serper, jina, searxng", () => {
		expect(Object.keys(adapters)).toEqual(["tavily", "brave", "exa", "serper", "jina", "searxng"]);
		expect(getAdapter("brave")).toBe(brave);
	});
	it("catalog exposes display metadata for every adapter", () => {
		const cat = catalog();
		expect(cat.map((c) => c.id)).toEqual(["tavily", "brave", "exa", "serper", "jina", "searxng"]);
		for (const c of cat) {
			expect(c.label.length).toBeGreaterThan(0);
			expect(c.defaultApiKeyEnv).toMatch(/_API_KEY$/);
			expect(["engine", "llm-native", "model-embedded", "self-hosted"]).toContain(c.kind);
		}
	});
	it("Config accepts brave/exa sections with defaults", () => {
		const c = new Config({ backend: "brave" });
		expect(c.brave.safesearch).toBe("moderate");
		expect(c.exa.type).toBe("auto");
	});
});

describe("brave adapter", () => {
	it("builds a GET with subscription token and query params", () => {
		const { url, init } = brave.buildRequest({ query: "hello world" }, { ...opts, backend: { country: "US", freshness: "pw" } });
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
		expect(u.searchParams.get("q")).toBe("hello world");
		expect(u.searchParams.get("count")).toBe("5");
		expect(u.searchParams.get("country")).toBe("US");
		expect(u.searchParams.get("freshness")).toBe("pw");
		expect(init.method).toBe("GET");
		expect(init.headers["x-subscription-token"]).toBe("k");
	});
	it("maps web.results and strips <strong> highlights", () => {
		const r = brave.parseResponse({ web: { results: [
			{ url: "https://a.com/x", title: "<strong>A</strong>", description: "desc &amp; more", page_age: "2024-01-01T00:00:00" },
			{ url: "https://a.com/x", title: "dup" },
			{ url: "", title: "empty" },
		] } }, { query: "q" }, { maxResults: 5 });
		expect(r.sources).toEqual([{ url: "https://a.com/x", title: "A", snippet: "desc & more", publishedAt: "2024-01-01T00:00:00" }]);
		expect(r.content).toBeUndefined();
		expect(r.truncated).toBe(false);
	});
	it("describes 401 and 429", () => {
		expect(brave.describeError(401, undefined, { apiKeyEnv: "BRAVE_SEARCH_API_KEY" })).toMatch(/BRAVE_SEARCH_API_KEY/);
		expect(brave.describeError(429, { error: { detail: "slow" } }, {})).toMatch(/rate limit.*slow/);
	});
});

describe("exa adapter", () => {
	it("builds a POST with x-api-key and highlights", () => {
		const { url, init } = exa.buildRequest({ query: "semantic" }, { ...opts, backend: { type: "neural", includeDomains: ["x.com"] } });
		expect(url).toBe("https://api.exa.ai/search");
		expect(init.headers["x-api-key"]).toBe("k");
		const body = JSON.parse(init.body);
		expect(body).toMatchObject({ query: "semantic", type: "neural", numResults: 5, includeDomains: ["x.com"] });
		expect(body.contents.highlights.highlightsPerUrl).toBe(2);
	});
	it("maps highlights to snippet, falls back to text", () => {
		const r = exa.parseResponse({ results: [
			{ url: "https://e.com/1", title: "One", highlights: ["first.", "second."], publishedDate: "2023-05-01" },
			{ url: "https://e.com/2", title: "Two", text: "full text here" },
		] }, { query: "q" }, { maxResults: 1 });
		expect(r.sources).toHaveLength(1);
		expect(r.sources[0]).toEqual({ url: "https://e.com/1", title: "One", snippet: "first. … second.", publishedAt: "2023-05-01" });
		expect(r.truncated).toBe(true);
	});
	it("describes 402 credit exhaustion", () => {
		expect(exa.describeError(402, { error: "no credit" }, {})).toMatch(/credit.*no credit/);
	});
});
