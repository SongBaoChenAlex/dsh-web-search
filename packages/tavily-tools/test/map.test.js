import { describe, it, expect, afterEach } from "vitest";
import { createTavilyClient } from "../lib/tavily-client.js";
import { applyWebMapTool, buildWebMapToolDefinition, formatMapOutput, shapeUrls, SessionBudget, WEB_MAP_SECTION_NAME, WEB_MAP_SECTION_ORDER } from "../lib/map.js";
import { startServer, json, clientOptions } from "./helpers.js";

let server;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

function fakeCtx() {
	const tools = [];
	const sections = [];
	return { ctx: { tools: { register(t) { tools.push(t); } }, systemPrompt: { section(s) { sections.push(s); } } }, tools, sections };
}

const exec = (session = "s1", signal) => ({ name: "web_map", arguments: {}, callId: "c1", agent: { session: { header: { id: session } } }, signal });

async function mount(baseURL, configPatch = {}) {
	const f = fakeCtx();
	const client = createTavilyClient({ resolveOptions: () => clientOptions({ baseURL }) });
	const config = () => ({ budgetPerSession: 5, defaultLimit: 30, maxLimit: 100, ...configPatch });
	const handles = await applyWebMapTool(f.ctx, { client, config, defineTool: (d) => d });
	return { ...f, handles, tool: f.tools[0] };
}

describe("shapeUrls / formatMapOutput", () => {
	it("dedupes (hash, trailing slash, host case), sorts and caps", () => {
		const r = shapeUrls(["https://a.com/b/", "https://A.com/b", "https://a.com/b#frag", "https://a.com/a", " ", "https://a.com/c"], 2);
		expect(r).toEqual({ urls: ["https://a.com/a", "https://a.com/b/"], truncated: true });
	});
	it("renders the list and the fetch hint", () => {
		const text = formatMapOutput({ baseUrl: "docs.x.com", urls: ["https://docs.x.com/a", "https://docs.x.com/b"], truncated: true });
		expect(text).toBe("Mapped docs.x.com (2 URLs, truncated):\n- https://docs.x.com/a\n- https://docs.x.com/b\nUse web_fetch on the relevant URL(s).");
	});
	it("renders a notice verbatim", () => {
		expect(formatMapOutput({ baseUrl: "x", urls: [], truncated: false, notice: "nope" })).toBe("nope");
	});
});

describe("web_map tool", () => {
	it("registers the tool definition and prompt section", async () => {
		const m = await mount("http://127.0.0.1:1");
		expect(m.tools).toHaveLength(1);
		expect(m.tool.name).toBe("web_map");
		expect(m.tool.parameters.url).toMatchObject({ type: "string", required: true });
		expect(m.tool.parameters).toHaveProperty("instructions");
		expect(m.tool.parameters).toHaveProperty("limit");
		expect(m.tool.parameters).toHaveProperty("maxDepth");
		expect(m.tool.output.schema.properties).toHaveProperty("baseUrl");
		expect(m.tool.output.schema.properties).toHaveProperty("notice");
		expect(m.tool.timeoutMs).toBe(60_000);
		expect(m.tool.isConcurrencySafe()).toBe(true);
		expect(m.sections).toEqual([expect.objectContaining({ name: WEB_MAP_SECTION_NAME, order: WEB_MAP_SECTION_ORDER })]);
		expect(m.sections[0].text).toContain("web_map");
	});

	it("posts the documented /map body and maps the response", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, {
			base_url: "docs.example.com",
			results: ["https://docs.example.com/b", "https://docs.example.com/a", "https://docs.example.com/a/", "https://docs.example.com/c"],
			response_time: 2.5,
		}));
		const m = await mount(server.baseURL);
		const value = await m.tool.execute({ url: "https://docs.example.com", instructions: "only API reference pages", limit: 2, maxDepth: 2 }, exec());
		expect(value).toEqual({ baseUrl: "docs.example.com", urls: ["https://docs.example.com/a", "https://docs.example.com/b"], truncated: true });

		const [req] = server.requests;
		expect(req.method).toBe("POST");
		expect(req.url).toBe("/map");
		expect(req.headers.authorization).toBe("Bearer tvly-test");
		expect(req.body).toEqual({ url: "https://docs.example.com", max_depth: 2, max_breadth: 20, limit: 2, instructions: "only API reference pages" });

		const [block] = m.tool.output.render({}, value);
		expect(block.type).toBe("text");
		expect(block.text).toMatch(/^Mapped docs\.example\.com \(2 URLs, truncated\):/u);
	});

	it("applies defaults and clamps limit / maxDepth", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { base_url: "x", results: [] }));
		const m = await mount(server.baseURL);
		await m.tool.execute({ url: "https://x.com" }, exec());
		await m.tool.execute({ url: "https://x.com", limit: 5000, maxDepth: 9 }, exec());
		await m.tool.execute({ url: "https://x.com", limit: 0, maxDepth: 0 }, exec());
		const bodies = server.requests.map((r) => ({ limit: r.body.limit, max_depth: r.body.max_depth, instructions: r.body.instructions }));
		expect(bodies).toEqual([
			{ limit: 30, max_depth: 1, instructions: undefined },
			{ limit: 100, max_depth: 3, instructions: undefined },
			{ limit: 1, max_depth: 1, instructions: undefined },
		]);
	});

	it("rejects empty and non-http urls before spending budget", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [] }));
		const m = await mount(server.baseURL);
		await expect(m.tool.execute({ url: "" }, exec())).rejects.toThrow(/non-empty/u);
		await expect(m.tool.execute({ url: "ftp://x.com" }, exec())).rejects.toThrow(/scheme/u);
		expect(server.requests).toHaveLength(0);
		expect(m.handles.budget.consume("s1").used).toBe(1);
	});

	it("allows 5 calls per session then returns a notice; sessions are independent", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { base_url: "x", results: ["https://x.com/p"] }));
		const m = await mount(server.baseURL);
		for (let i = 0; i < 5; i++) {
			const v = await m.tool.execute({ url: "https://x.com" }, exec("s1"));
			expect(v.urls).toEqual(["https://x.com/p"]);
			expect(v.notice).toBeUndefined();
		}
		const sixth = await m.tool.execute({ url: "https://x.com" }, exec("s1"));
		expect(sixth).toMatchObject({ baseUrl: "https://x.com", urls: [], truncated: false });
		expect(sixth.notice).toMatch(/budget.*exhausted/u);
		expect(sixth.notice).toContain("5/5");
		expect(server.requests).toHaveLength(5);
		expect(m.tool.output.render({}, sixth)[0].text).toBe(sixth.notice);
		expect(m.tool.output.presentationMeta({}, sixth)).toMatchObject({ budgetExhausted: true });

		const other = await m.tool.execute({ url: "https://x.com" }, exec("s2"));
		expect(other.notice).toBeUndefined();
		expect(server.requests).toHaveLength(6);
	});

	it("uses the anonymous bucket when exec has no agent", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [] }));
		const m = await mount(server.baseURL, { budgetPerSession: 1 });
		await m.tool.execute({ url: "https://x.com" }, { signal: undefined });
		const v = await m.tool.execute({ url: "https://x.com" }, {});
		expect(v.notice).toBeDefined();
	});

	it("budgetPerSession 0 is unlimited", async () => {
		server = await startServer((_req, _body, res) => json(res, 200, { results: [] }));
		const m = await mount(server.baseURL, { budgetPerSession: 0 });
		for (let i = 0; i < 8; i++) await m.tool.execute({ url: "https://x.com" }, exec());
		expect(server.requests).toHaveLength(8);
	});

	it("propagates provider errors (401 → WEB_PROVIDER_ERROR) and forwards exec.signal", async () => {
		server = await startServer((_req, _body, res) => json(res, 401, { detail: { error: "bad key" } }));
		const m = await mount(server.baseURL);
		const err = await m.tool.execute({ url: "https://x.com" }, exec()).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toContain("TAVILY_API_KEY");
		expect(err.message).toContain("map");

		const aborted = await m.tool.execute({ url: "https://x.com" }, exec("s1", AbortSignal.abort())).catch((e) => e);
		expect(aborted.code).toBe("WEB_ABORTED");
	});

	it("buildWebMapToolDefinition accepts an explicit budget", () => {
		const budget = new SessionBudget(2);
		const def = buildWebMapToolDefinition({ client: {}, config: () => ({}), budget, timeoutMs: 1234 });
		expect(def.timeoutMs).toBe(1234);
		expect(budget.consume("a")).toEqual({ allowed: true, used: 1, limit: 2 });
	});
});
