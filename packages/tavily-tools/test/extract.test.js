import { describe, it, expect, afterEach } from "vitest";
import { createTavilyClient } from "../lib/tavily-client.js";
import { TavilyExtractFetchProvider, TAVILY_EXTRACT_PROVIDER_ID, capText } from "../lib/extract.js";
import { startServer, json, clientOptions } from "./helpers.js";

let server;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

function makeProvider(optionOverrides = {}, extractOptions = {}) {
	const options = clientOptions(optionOverrides);
	const client = createTavilyClient({ resolveOptions: () => options });
	return { provider: new TavilyExtractFetchProvider(client, () => extractOptions), options };
}

const PAGE = "https://example.com/docs/intro";

describe("capText", () => {
	it("passes short text through and caps long text with a trailer", () => {
		expect(capText("abc", 10)).toEqual({ text: "abc", truncated: false });
		const r = capText("x".repeat(50), 10);
		expect(r.truncated).toBe(true);
		expect(r.text).toBe(`${"x".repeat(10)}\n[truncated: shown 10 of 50 chars]`);
	});
});

describe("TavilyExtractFetchProvider", () => {
	it("has the stable provider id", () => {
		expect(makeProvider().provider.id).toBe("tavily-extract");
		expect(TAVILY_EXTRACT_PROVIDER_ID).toBe("tavily-extract");
	});

	it("extracts markdown through /extract with the documented body", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, {
			results: [{ url: PAGE, raw_content: "# Intro\n\nHello **world**." }],
			failed_results: [],
			response_time: 1.2,
		}));
		const { provider } = makeProvider({ baseURL: server.baseURL }, { depth: "advanced" });
		const result = await provider.fetch({ url: PAGE });
		expect(result).toEqual({ url: PAGE, statusCode: 200, body: { kind: "text", content: "# Intro\n\nHello **world**." }, truncated: false });

		expect(server.requests).toHaveLength(1);
		const [req] = server.requests;
		expect(req.method).toBe("POST");
		expect(req.url).toBe("/extract");
		expect(req.headers.authorization).toBe("Bearer tvly-test");
		expect(req.headers["content-type"]).toBe("application/json");
		expect(req.body).toEqual({ urls: [PAGE], extract_depth: "advanced", format: "markdown", include_images: false });
	});

	it("defaults to basic depth", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [{ url: PAGE, raw_content: "x" }] }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		await provider.fetch({ url: PAGE });
		expect(server.requests[0].body.extract_depth).toBe("basic");
	});

	it("returns a 502 result (not a throw) when the URL is in failed_results", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, {
			results: [],
			failed_results: [{ url: PAGE, error: "Page returned 403" }],
		}));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const result = await provider.fetch({ url: PAGE });
		expect(result.statusCode).toBe(502);
		expect(result.body).toEqual({ kind: "text", content: `Tavily could not extract ${PAGE}: Page returned 403` });
		expect(result.truncated).toBe(false);
		expect(result.url).toBe(PAGE);
	});

	it("returns 502 when Tavily returns neither a result nor a failure", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [], failed_results: [] }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const result = await provider.fetch({ url: PAGE });
		expect(result.statusCode).toBe(502);
		expect(result.body.content).toContain("no content returned");
	});

	it("caps the body at maxOutputChars and marks truncated", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [{ url: PAGE, raw_content: "y".repeat(5000) }] }));
		const { provider } = makeProvider({ baseURL: server.baseURL }, { maxOutputChars: 1000 });
		const result = await provider.fetch({ url: PAGE });
		expect(result.truncated).toBe(true);
		expect(result.body.content.startsWith("y".repeat(1000))).toBe(true);
		expect(result.body.content.endsWith("\n[truncated: shown 1000 of 5000 chars]")).toBe(true);
	});

	it("maps 401 to WEB_PROVIDER_ERROR mentioning the credential name", async () => {
		server = await startServer((_req, _body, res) => json(res, 401, { detail: { error: "Unauthorized: missing or invalid API key." } }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.fetch({ url: PAGE }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toContain("TAVILY_API_KEY");
		expect(err.message).toContain("Unauthorized: missing or invalid API key.");
		expect(err.message).toContain("extract");
	});

	it("maps 432 to a plan-limit message", async () => {
		server = await startServer((_req, _body, res) => json(res, 432, { detail: { error: "limit" } }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.fetch({ url: PAGE }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/plan usage limit/u);
	});

	it("times out as WEB_PROVIDER_ERROR", async () => {
		server = await startServer(() => { /* never reply */ });
		const { provider } = makeProvider({ baseURL: server.baseURL, timeoutMs: 50 });
		const started = Date.now();
		const err = await provider.fetch({ url: PAGE }).catch((e) => e);
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/timed out after 50 ms/u);
	});

	it("reports WEB_ABORTED when the caller aborts mid-flight", async () => {
		server = await startServer(() => { /* never reply */ });
		const { provider } = makeProvider({ baseURL: server.baseURL, timeoutMs: 5_000 });
		const controller = new AbortController();
		const pending = provider.fetch({ url: PAGE }, controller.signal).catch((e) => e);
		setTimeout(() => controller.abort(new Error("user cancelled")), 20);
		const err = await pending;
		expect(err.code).toBe("WEB_ABORTED");
		expect(err.cause?.message).toBe("user cancelled");
	});

	it("reports WEB_ABORTED for an already-aborted signal without touching the network", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [] }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		const err = await provider.fetch({ url: PAGE }, AbortSignal.abort()).catch((e) => e);
		expect(err.code).toBe("WEB_ABORTED");
		expect(server.requests).toHaveLength(0);
	});

	it("rejects non-http(s) schemes up front", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [] }));
		const { provider } = makeProvider({ baseURL: server.baseURL });
		for (const bad of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "not a url", ""]) {
			const err = await provider.fetch({ url: bad }).catch((e) => e);
			expect(err.code, bad).toBe("WEB_PROVIDER_ERROR");
		}
		expect(server.requests).toHaveLength(0);
	});

	describe("credentials", () => {
		it("is unavailable without any key source and throws WEB_PROVIDER_CREDENTIAL_MISSING", async () => {
			const { provider } = makeProvider({ apiKey: undefined, resolveApiKey: undefined, canResolveApiKey: () => false });
			expect(provider.available()).toBe(false);
			const err = await provider.fetch({ url: PAGE }).catch((e) => e);
			expect(err.code).toBe("WEB_PROVIDER_CREDENTIAL_MISSING");
			expect(err.message).toContain("TAVILY_API_KEY");
		});

		it("resolves the key lazily", async () => {
			server = await startServer((_req, _body, res) => json(res, 200, { results: [{ url: PAGE, raw_content: "ok" }] }));
			const { provider } = makeProvider({ apiKey: undefined, baseURL: server.baseURL, resolveApiKey: async () => "tvly-resolved", canResolveApiKey: () => true });
			expect(provider.available()).toBe(true);
			await provider.fetch({ url: PAGE });
			expect(server.requests[0].headers.authorization).toBe("Bearer tvly-resolved");
		});
	});
});
