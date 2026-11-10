import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { serper } from "../lib/adapters/serper.js";
import { searxng } from "../lib/adapters/searxng.js";
import { jina } from "../lib/adapters/jina.js";
import { catalog, getAdapter } from "../lib/adapter.js";
import { Config, HttpSearchProvider, SERPER_PROVIDER_ID, JINA_PROVIDER_ID, SEARXNG_PROVIDER_ID } from "../lib/index.js";

const opts = { apiKey: "k", baseURL: "", maxResults: 5, userAgent: "ua" };

/** Local fake endpoint; `handler(req, body, res)` decides the reply. Never touches the network. */
async function startServer(handler) {
	const requests = [];
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => { raw += c; });
		req.on("end", () => {
			const body = raw.length > 0 ? JSON.parse(raw) : undefined;
			requests.push({ method: req.method, url: req.url, headers: req.headers, body });
			handler(req, body, res);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		baseURL: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
	};
}

function json(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function makeProvider(adapter, overrides = {}) {
	const options = {
		adapter,
		apiKey: "test-key",
		apiKeyEnv: adapter.defaultApiKeyEnv,
		baseURL: "http://127.0.0.1:1",
		timeoutMs: 2_000,
		maxResults: 5,
		backend: {},
		recordRequest: () => {},
		...overrides,
	};
	return new HttpSearchProvider(() => options);
}

let server;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("registry wiring", () => {
	it("exposes provider ids and catalog order", () => {
		expect(SERPER_PROVIDER_ID).toBe("serper");
		expect(JINA_PROVIDER_ID).toBe("jina");
		expect(SEARXNG_PROVIDER_ID).toBe("searxng");
		expect(getAdapter("serper")).toBe(serper);
		expect(getAdapter("jina")).toBe(jina);
		expect(getAdapter("searxng")).toBe(searxng);
		const cat = catalog();
		expect(cat.map((c) => c.id)).toEqual(["tavily", "brave", "exa", "serper", "jina", "searxng"]);
		expect(cat.find((c) => c.id === "searxng")).toMatchObject({ requiresKey: false, keyUrl: "", kind: "self-hosted" });
		expect(cat.find((c) => c.id === "serper")).toMatchObject({ requiresKey: true, label: "Serper" });
	});
	it("Config accepts the new sections with defaults", () => {
		const c = new Config({ backend: "searxng" });
		expect(c.serper).toEqual({ gl: "", hl: "" });
		expect(c.jina).toEqual({ site: "" });
		expect(c.searxng).toMatchObject({ language: "", safesearch: 1, timeRange: "" });
		expect(() => new Config({ searxng: { safesearch: 5 } })).toThrow();
	});
});

describe("serper adapter", () => {
	it("builds a POST with X-API-KEY and num capped at 10", () => {
		const { url, init } = serper.buildRequest({ query: "hello" }, { ...opts, maxResults: 20, backend: { gl: "us", hl: "en" } });
		expect(url).toBe("https://google.serper.dev/search");
		expect(init.method).toBe("POST");
		expect(init.headers["x-api-key"]).toBe("k");
		expect(JSON.parse(init.body)).toEqual({ q: "hello", num: 10, gl: "us", hl: "en" });
	});
	it("maps organic[] and the answer box", () => {
		const r = serper.parseResponse({
			answerBox: { title: "Height", answer: "8,849 m", link: "https://x" },
			knowledgeGraph: { title: "Everest", description: "mountain" },
			organic: [
				{ title: "One", link: "https://a.com/1", snippet: "first &amp; foremost", date: "Jan 1, 2024" },
				{ title: "NoSnippet", link: "https://a.com/2" },
				{ title: "dup", link: "https://a.com/1" },
				{ title: "nolink" },
			],
		}, { query: "q" }, { maxResults: 5 });
		expect(r.content).toBe("Height: 8,849 m");
		expect(r.sources).toEqual([
			{ url: "https://a.com/1", title: "One", snippet: "first & foremost", publishedAt: "Jan 1, 2024" },
			{ url: "https://a.com/2", title: "NoSnippet" },
		]);
		expect(r.truncated).toBe(false);
	});
	it("uses answerBox.snippet when no answer, and omits content when neither", () => {
		expect(serper.parseResponse({ answerBox: { snippet: "some text" }, organic: [] }, { query: "q" }, { maxResults: 5 }))
			.toEqual({ content: "some text", sources: [], truncated: false });
		expect(serper.parseResponse({}, { query: "q" }, { maxResults: 5 })).toEqual({ sources: [], truncated: false });
	});
	it("describes 401 / 429 / 402", () => {
		expect(serper.describeError(401, undefined, { apiKeyEnv: "SERPER_API_KEY" })).toMatch(/SERPER_API_KEY/);
		expect(serper.describeError(429, { message: "slow down" }, {})).toMatch(/rate limit.*slow down/);
		expect(serper.describeError(402, undefined, {})).toMatch(/credit/);
	});
	it("round-trips through HttpSearchProvider against a fake server", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { organic: [{ title: "T", link: "https://t.dev", snippet: "s" }] }));
		const provider = makeProvider(serper, { baseURL: server.baseURL });
		expect(provider.id).toBe("serper");
		expect(provider.available()).toBe(true);
		const r = await provider.search({ query: "dsh", maxResults: 3 });
		expect(r.sources).toEqual([{ url: "https://t.dev", title: "T", snippet: "s" }]);
		const [req] = server.requests;
		expect(req.method).toBe("POST");
		expect(req.url).toBe("/search");
		expect(req.headers["x-api-key"]).toBe("test-key");
		expect(req.headers["content-type"]).toBe("application/json");
		expect(req.body).toEqual({ q: "dsh", num: 3 });
	});
});

describe("searxng adapter", () => {
	it("builds a GET with format=json and no auth header when key-less", () => {
		const { url, init } = searxng.buildRequest({ query: "hello world" }, { ...opts, apiKey: "", backend: { language: "en", timeRange: "month" } });
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe("http://127.0.0.1:8080/search");
		expect(u.searchParams.get("q")).toBe("hello world");
		expect(u.searchParams.get("format")).toBe("json");
		expect(u.searchParams.get("language")).toBe("en");
		expect(u.searchParams.get("time_range")).toBe("month");
		expect(u.searchParams.get("safesearch")).toBe("1");
		expect(init.method).toBe("GET");
		expect(init.headers.authorization).toBeUndefined();
	});
	it("sends Authorization: Bearer only when a key is present", () => {
		const { init } = searxng.buildRequest({ query: "x" }, { ...opts, apiKey: "tok", baseURL: "https://sx.example/" });
		expect(init.headers.authorization).toBe("Bearer tok");
	});
	it("maps results[] and answers[0]", () => {
		const r = searxng.parseResponse({
			answers: ["42 is the answer", "ignored"],
			infoboxes: [{ content: "ignored too" }],
			results: [
				{ url: "https://s.com/1", title: "One", content: "body text", publishedDate: "2024-02-02T00:00:00", engine: "duckduckgo" },
				{ url: "https://s.com/2", title: "Two" },
				{ url: "https://s.com/1", title: "dup" },
			],
		}, { query: "q" }, { maxResults: 1 });
		expect(r.content).toBe("42 is the answer");
		expect(r.sources).toEqual([{ url: "https://s.com/1", title: "One", snippet: "body text", publishedAt: "2024-02-02T00:00:00" }]);
		expect(r.truncated).toBe(true);
	});
	it("handles empty / missing fields", () => {
		expect(searxng.parseResponse({ results: [], answers: [] }, { query: "q" }, { maxResults: 5 })).toEqual({ sources: [], truncated: false });
		expect(searxng.parseResponse({}, { query: "q" }, { maxResults: 5 })).toEqual({ sources: [], truncated: false });
	});
	it("describes 403 and 404", () => {
		expect(searxng.describeError(403, undefined, { apiKeyEnv: "SEARXNG_API_KEY" })).toMatch(/SEARXNG_API_KEY/);
		expect(searxng.describeError(404, undefined, {})).toMatch(/baseURL/);
	});
	it("is available and searches without any key through HttpSearchProvider", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [{ url: "https://r.io", title: "R", content: "c" }], answers: [] }));
		const provider = makeProvider(searxng, {
			apiKey: undefined,
			baseURL: server.baseURL,
			resolveApiKey: async () => undefined,
			canResolveApiKey: () => false,
		});
		expect(provider.available()).toBe(true);
		const r = await provider.search({ query: "self hosted", maxResults: 2 });
		expect(r).toEqual({ sources: [{ url: "https://r.io", title: "R", snippet: "c" }], truncated: false });
		const [req] = server.requests;
		expect(req.method).toBe("GET");
		const u = new URL(req.url, "http://x");
		expect(u.pathname).toBe("/search");
		expect(u.searchParams.get("q")).toBe("self hosted");
		expect(u.searchParams.get("format")).toBe("json");
		expect(req.headers.authorization).toBeUndefined();
	});
	it("is unavailable when baseURL does not parse", () => {
		const provider = makeProvider(searxng, { apiKey: undefined, baseURL: "not a url", canResolveApiKey: () => false });
		expect(provider.available()).toBe(false);
	});
});

describe("jina adapter", () => {
	it("builds a GET on s.jina.ai with bearer, json accept and no-content", () => {
		const { url, init } = jina.buildRequest({ query: "reader style" }, { ...opts, backend: { site: "example.com" } });
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe("https://s.jina.ai/");
		expect(u.searchParams.get("q")).toBe("reader style");
		expect(init.method).toBe("GET");
		expect(init.headers.authorization).toBe("Bearer k");
		expect(init.headers.accept).toBe("application/json");
		expect(init.headers["x-respond-with"]).toBe("no-content");
		expect(init.headers["x-site"]).toBe("example.com");
	});
	it("maps data[], preferring description over truncated content", () => {
		const long = "x".repeat(400);
		const r = jina.parseResponse({ data: [
			{ url: "https://j.ai/1", title: "One", description: "desc", content: long, date: "2024-03-03" },
			{ url: "https://j.ai/2", title: "Two", content: long },
			{ url: "https://j.ai/3" },
			{ title: "no url" },
		] }, { query: "q" }, { maxResults: 5 });
		expect(r.content).toBeUndefined();
		expect(r.sources).toHaveLength(3);
		expect(r.sources[0]).toEqual({ url: "https://j.ai/1", title: "One", snippet: "desc", publishedAt: "2024-03-03" });
		expect(r.sources[1].snippet).toBe("x".repeat(300));
		expect(r.sources[2]).toEqual({ url: "https://j.ai/3" });
	});
	it("handles empty data", () => {
		expect(jina.parseResponse({ data: [] }, { query: "q" }, { maxResults: 5 })).toEqual({ sources: [], truncated: false });
		expect(jina.parseResponse({}, { query: "q" }, { maxResults: 5 })).toEqual({ sources: [], truncated: false });
	});
	it("describes 401 and 402", () => {
		expect(jina.describeError(401, undefined, { apiKeyEnv: "JINA_API_KEY" })).toMatch(/JINA_API_KEY/);
		expect(jina.describeError(402, { readableMessage: "no tokens" }, {})).toMatch(/token.*no tokens/);
	});
	it("round-trips through HttpSearchProvider against a fake server", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { code: 200, data: [{ url: "https://j.ai/p", title: "P", description: "d" }] }));
		const provider = makeProvider(jina, { baseURL: server.baseURL });
		const r = await provider.search({ query: "q" });
		expect(r.sources).toEqual([{ url: "https://j.ai/p", title: "P", snippet: "d" }]);
		const [req] = server.requests;
		expect(req.method).toBe("GET");
		expect(req.url).toBe("/?q=q");
		expect(req.headers.authorization).toBe("Bearer test-key");
		expect(req.headers.accept).toBe("application/json");
		expect(req.headers["x-respond-with"]).toBe("no-content");
	});
});
