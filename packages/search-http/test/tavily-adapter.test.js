import { describe, it, expect } from "vitest";
import { adapters, getAdapter } from "../lib/adapter.js";
import { tavily, TAVILY_MAX_RESULTS } from "../lib/adapters/tavily.js";
import fixture from "./fixtures/tavily-response.json" with { type: "json" };

const baseOptions = { apiKey: "tvly-test", baseURL: "https://api.tavily.com", maxResults: 5, userAgent: "ua/1" };

describe("adapter registry", () => {
	it("exposes tavily", () => {
		expect(Object.keys(adapters)).toContain("tavily");
		expect(getAdapter("tavily")).toBe(tavily);
	});
	it("throws a clear error for unknown ids", () => {
		expect(() => getAdapter("bing")).toThrow(/unknown backend "bing".*known backends: "tavily"/u);
		expect(() => getAdapter(undefined)).toThrow(/unknown backend/u);
	});
});

describe("tavily.buildRequest", () => {
	it("POSTs JSON to <baseURL>/search with a bearer token", () => {
		const { url, init } = tavily.buildRequest({ query: "deepseek harness" }, baseOptions);
		expect(url).toBe("https://api.tavily.com/search");
		expect(init.method).toBe("POST");
		expect(init.redirect).toBe("error");
		expect(init.headers.authorization).toBe("Bearer tvly-test");
		expect(init.headers["content-type"]).toBe("application/json");
		expect(init.headers["user-agent"]).toBe("ua/1");
		const body = JSON.parse(init.body);
		expect(body).toEqual({
			query: "deepseek harness",
			search_depth: "basic",
			max_results: 5,
			include_answer: true,
			include_raw_content: false,
			topic: "general",
		});
		expect(body.api_key).toBeUndefined();
	});

	it("tolerates trailing slashes and applies backend options", () => {
		const { url, init } = tavily.buildRequest({ query: "q" }, {
			...baseOptions,
			baseURL: "http://127.0.0.1:9/v1///",
			maxResults: 7,
			backend: { searchDepth: "advanced", includeAnswer: false, topic: "news", includeDomains: ["example.com", " "], excludeDomains: [] },
		});
		expect(url).toBe("http://127.0.0.1:9/v1/search");
		const body = JSON.parse(init.body);
		expect(body.search_depth).toBe("advanced");
		expect(body.include_answer).toBe(false);
		expect(body.topic).toBe("news");
		expect(body.max_results).toBe(7);
		expect(body.include_domains).toEqual(["example.com"]);
		expect(body.exclude_domains).toBeUndefined();
	});

	it("clamps max_results to Tavily's ceiling", () => {
		const { init } = tavily.buildRequest({ query: "q" }, { ...baseOptions, maxResults: 99 });
		expect(JSON.parse(init.body).max_results).toBe(TAVILY_MAX_RESULTS);
	});
});

describe("tavily.parseResponse", () => {
	it("maps answer → content, content → snippet, published_date → publishedAt, dedupes by url", () => {
		const result = tavily.parseResponse(fixture, { query: fixture.query }, { maxResults: 5 });
		expect(result.content).toBe(fixture.answer);
		expect(result.truncated).toBe(false);
		// fixture has 4 results, one duplicate url, one with empty url → 2 unique
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0]).toEqual({
			url: "https://example.com/dsh",
			title: "DeepSeek Harness — docs",
			snippet: "DSH is a harness & toolkit. It wires plugins via cordis.",
			publishedAt: "2025-01-15T10:00:00Z",
		});
		expect(result.sources[1]).toEqual({ url: "https://example.org/other", title: "Other" });
		for (const s of result.sources) {
			expect(s).not.toHaveProperty("score");
			expect(s).not.toHaveProperty("raw_content");
		}
	});

	it("respects maxResults and flags truncation", () => {
		const json = { results: Array.from({ length: 8 }, (_, i) => ({ url: `https://e.com/${i}`, title: `t${i}`, content: `c${i}` })) };
		const result = tavily.parseResponse(json, { query: "q" }, { maxResults: 3 });
		expect(result.sources).toHaveLength(3);
		expect(result.truncated).toBe(true);
		expect(result.content).toBeUndefined();
	});

	it("handles a malformed body gracefully", () => {
		expect(tavily.parseResponse(null, { query: "q" }, { maxResults: 5 })).toEqual({ sources: [], truncated: false });
		expect(tavily.parseResponse({ results: "nope", answer: "   " }, { query: "q" }, { maxResults: 5 })).toEqual({ sources: [], truncated: false });
	});
});

describe("tavily.describeError", () => {
	it("mentions the key on 401/403", () => {
		const m = tavily.describeError(401, { detail: { error: "Unauthorized: missing or invalid API key." } }, { apiKeyEnv: "TAVILY_API_KEY" });
		expect(m).toMatch(/API key/u);
		expect(m).toContain("TAVILY_API_KEY");
		expect(m).toContain("Unauthorized: missing or invalid API key.");
		expect(tavily.describeError(403, undefined, { apiKeyEnv: "X" })).toMatch(/key.*"X"/u);
	});
	it("describes 429 and 432", () => {
		expect(tavily.describeError(429, { error: "Too many requests" }, { apiKeyEnv: "X" })).toMatch(/rate limit.*Too many requests/u);
		expect(tavily.describeError(432, undefined, { apiKeyEnv: "X" })).toMatch(/plan|quota/u);
	});
	it("falls back to a generic message", () => {
		expect(tavily.describeError(500, "boom", { apiKeyEnv: "X" })).toBe("Tavily API error (HTTP 500): boom");
	});
});
