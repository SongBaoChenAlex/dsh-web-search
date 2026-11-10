import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { HttpSearchProvider, TAVILY_PROVIDER_ID, name, inject, Config } from "../lib/index.js";
import { tavily } from "../lib/adapters/tavily.js";
import fixture from "./fixtures/tavily-response.json" with { type: "json" };

/** Start a fake Tavily endpoint; `handler(req, body, res)` decides the reply. */
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

function makeProvider(overrides = {}) {
	const options = {
		adapter: tavily,
		apiKey: "tvly-test",
		apiKeyEnv: "TAVILY_API_KEY",
		baseURL: "http://127.0.0.1:1",
		timeoutMs: 2_000,
		maxResults: 5,
		backend: {},
		...overrides,
	};
	const recorded = [];
	options.recordRequest ??= (r) => recorded.push(r);
	return { provider: new HttpSearchProvider(() => options), recorded, options };
}

let server;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("plugin surface", () => {
	it("exports cordis metadata and defaults", () => {
		expect(name).toBe("web-search-http");
		expect(inject).toEqual(["web"]);
		expect(TAVILY_PROVIDER_ID).toBe("tavily");
		const cfg = new Config({});
		expect(cfg.backend).toBe("tavily");
		expect(cfg.timeoutMs).toBe(20_000);
		expect(cfg.maxResults).toBe(5);
		expect(cfg.tavily).toMatchObject({ searchDepth: "basic", includeAnswer: true, includeRawContent: false, topic: "general" });
	});
	it("rejects invalid tavily options", () => {
		expect(() => new Config({ tavily: { searchDepth: "deep" } })).toThrow();
	});
});

describe("HttpSearchProvider", () => {
	it("uses the backend id as provider id", () => {
		expect(makeProvider().provider.id).toBe("tavily");
	});

	it("searches a fake Tavily endpoint and maps the response", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, fixture));
		const { provider, recorded } = makeProvider({ baseURL: server.baseURL });
		expect(provider.available()).toBe(true);
		const result = await provider.search({ query: "deepseek harness", maxResults: 3 });
		expect(result.content).toBe(fixture.answer);
		expect(result.sources.map((s) => s.url)).toEqual(["https://example.com/dsh", "https://example.org/other"]);

		expect(server.requests).toHaveLength(1);
		const [req] = server.requests;
		expect(req.method).toBe("POST");
		expect(req.url).toBe("/search");
		expect(req.headers.authorization).toBe("Bearer tvly-test");
		expect(req.headers["content-type"]).toBe("application/json");
		expect(req.body).toMatchObject({ query: "deepseek harness", max_results: 3, include_raw_content: false });

		expect(recorded).toEqual([{ endpoint: `${server.baseURL}/search`, backend: "tavily", query: "deepseek harness", maxResults: 3 }]);
	});

	it("falls back to config.maxResults and clamps at 20", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [] }));
		const { provider } = makeProvider({ baseURL: server.baseURL, maxResults: 7 });
		await provider.search({ query: "a" });
		await provider.search({ query: "b", maxResults: 500 });
		expect(server.requests.map((r) => r.body.max_results)).toEqual([7, 20]);
	});

	it("maps 401 to WEB_PROVIDER_ERROR mentioning the key", async () => {
		server = await startServer((_req, _body, res) => json(res, 401, { detail: { error: "Unauthorized: missing or invalid API key." } }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.search({ query: "x" }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/API key/u);
		expect(err.message).toContain("TAVILY_API_KEY");
		expect(err.message).toContain("Unauthorized: missing or invalid API key.");
	});

	it("maps 429 to WEB_PROVIDER_ERROR with a rate-limit message", async () => {
		server = await startServer((_req, _body, res) => json(res, 429, { error: "rate limited" }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.search({ query: "x" }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/rate limit/iu);
		expect(err.message).toContain("rate limited");
	});

	it("maps a non-JSON 5xx body without crashing", async () => {
		server = await startServer((_req, _body, res) => { res.writeHead(502, { "content-type": "text/html" }); res.end("<h1>Bad gateway</h1>"); });
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.search({ query: "x" }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toContain("HTTP 502");
	});

	it("times out when the server never responds", async () => {
		server = await startServer(() => { /* never reply */ });
		const { provider } = makeProvider({ baseURL: server.baseURL, timeoutMs: 50 });
		const started = Date.now();
		const err = await provider.search({ query: "slow" }).catch((e) => e);
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/timed out after 50 ms/u);
		expect(err.message).toContain("timeoutMs");
	});

	it("reports WEB_ABORTED when the caller aborts mid-flight", async () => {
		server = await startServer(() => { /* never reply */ });
		const { provider } = makeProvider({ baseURL: server.baseURL, timeoutMs: 5_000 });
		const controller = new AbortController();
		const pending = provider.search({ query: "slow" }, controller.signal).catch((e) => e);
		setTimeout(() => controller.abort(new Error("user cancelled")), 20);
		const err = await pending;
		expect(err.code).toBe("WEB_ABORTED");
		expect(err.cause?.message).toBe("user cancelled");
	});

	it("reports WEB_ABORTED for an already-aborted signal without touching the network", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, fixture));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.search({ query: "x" }, AbortSignal.abort()).catch((e) => e);
		expect(err.code).toBe("WEB_ABORTED");
		expect(server.requests).toHaveLength(0);
	});

	it("treats a redirect as a provider error", async () => {
		server = await startServer((_req, _body, res) => { res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }); res.end(); });
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.search({ query: "x" }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
	});

	describe("credentials", () => {
		it("is unavailable without any key source and throws WEB_PROVIDER_CREDENTIAL_MISSING", async () => {
			const { provider } = makeProvider({ apiKey: undefined, resolveApiKey: undefined, canResolveApiKey: () => false });
			expect(provider.available()).toBe(false);
			const err = await provider.search({ query: "x" }).catch((e) => e);
			expect(err.code).toBe("WEB_PROVIDER_CREDENTIAL_MISSING");
			expect(err.message).toContain("TAVILY_API_KEY");
		});

		it("is unavailable when baseURL is unparseable", () => {
			const { provider } = makeProvider({ baseURL: "not a url" });
			expect(provider.available()).toBe(false);
		});

		it("resolves the key lazily through resolveApiKey", async () => {
			server = await startServer((_req, _body, res) => json(res, 200, { results: [] }));
			const { provider } = makeProvider({ apiKey: undefined, baseURL: server.baseURL, resolveApiKey: async () => "tvly-resolved", canResolveApiKey: () => true });
			expect(provider.available()).toBe(true);
			await provider.search({ query: "x" });
			expect(server.requests[0].headers.authorization).toBe("Bearer tvly-resolved");
		});

		it("throws WEB_PROVIDER_CREDENTIAL_MISSING when the resolver yields nothing", async () => {
			const { provider } = makeProvider({ apiKey: undefined, resolveApiKey: async () => undefined, canResolveApiKey: () => true });
			// available() is optimistic (a credentials service exists) but search() still fails cleanly.
			expect(provider.available()).toBe(true);
			const err = await provider.search({ query: "x" }).catch((e) => e);
			expect(err.code).toBe("WEB_PROVIDER_CREDENTIAL_MISSING");
		});
	});
});
