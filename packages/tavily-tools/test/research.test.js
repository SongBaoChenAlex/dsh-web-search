import { describe, it, expect, afterEach } from "vitest";
import { createTavilyClient } from "../lib/tavily-client.js";
import {
	applyWebResearchTool, buildWebResearchToolDefinition, formatResearchOutput, shapeSources, capAnswer, researchGuidance,
	SessionBudget, WEB_RESEARCH_SECTION_NAME, WEB_RESEARCH_SECTION_ORDER, RESEARCH_DEFAULTS,
} from "../lib/research.js";
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

const exec = (session = "s1", signal) => ({ name: "web_research", arguments: {}, callId: "c1", agent: { session: { header: { id: session } } }, signal });

async function mount(baseURL, configPatch = {}) {
	const f = fakeCtx();
	const client = createTavilyClient({ resolveOptions: () => clientOptions({ baseURL }) });
	const config = () => ({ pollIntervalMs: 10, timeoutMs: 2_000, ...configPatch });
	const handles = await applyWebResearchTool(f.ctx, { client, config, defineTool: (d) => d });
	return { ...f, handles, tool: f.tools[0] };
}

const COMPLETED = {
	request_id: "req-1",
	status: "completed",
	content: "Answer body [1] and more [2].",
	sources: [{ url: "https://a.com/x", title: "A" }, { url: "https://b.com/y" }],
	created_at: "2025-01-01T00:00:00Z",
	response_time: 15.2,
};

/** Fake Tavily: POST /research → pending; GET /research/{id} walks `statuses` in order. */
function researchServer(statuses) {
	let i = 0;
	return startServer((req, _body, res) => {
		if (req.method === "POST" && req.url === "/research") {
			return json(res, 200, { request_id: "req-1", status: "pending", input: "q", model: "mini", created_at: "2025-01-01T00:00:00Z" });
		}
		if (req.method === "GET" && req.url.startsWith("/research/")) {
			const payload = statuses[Math.min(i, statuses.length - 1)];
			i++;
			return json(res, 200, typeof payload === "function" ? payload() : payload);
		}
		return json(res, 404, { detail: "not found" });
	});
}

describe("pure helpers", () => {
	it("shapeSources normalizes strings and objects, dedupes and caps", () => {
		const s = shapeSources(["https://a.com", { url: "https://a.com" }, { url: " https://b.com ", title: " B " }, { title: "no url" }, { url: "https://c.com" }], 2);
		expect(s).toEqual([{ url: "https://a.com" }, { url: "https://b.com", title: "B" }]);
		expect(shapeSources(undefined, 5)).toEqual([]);
	});
	it("capAnswer truncates past the cap", () => {
		expect(capAnswer("abcdef", 10)).toEqual({ answer: "abcdef", truncated: false });
		expect(capAnswer("abc def", 4)).toEqual({ answer: "abc", truncated: true });
		expect(capAnswer(undefined, 4)).toEqual({ answer: "", truncated: false });
	});
	it("formatResearchOutput renders answer then numbered sources", () => {
		const text = formatResearchOutput({ answer: "Body [1].", sources: [{ url: "https://a.com", title: "A" }, { url: "https://b.com" }], truncated: false });
		expect(text).toBe("Body [1].\n\nSources:\n1. A — https://a.com\n2. https://b.com");
	});
	it("formatResearchOutput renders a bare notice verbatim and appends a truncation notice", () => {
		expect(formatResearchOutput({ answer: "", sources: [], truncated: false, notice: "nope" })).toBe("nope");
		const text = formatResearchOutput({ answer: "Body", sources: [], truncated: true, notice: "[truncated]" });
		expect(text).toBe("Body\n\n[truncated]");
	});
	it("researchGuidance mentions the budget count", () => {
		expect(researchGuidance(2)).toContain("2 calls per session");
		expect(researchGuidance(1)).toContain("1 call per session");
		expect(researchGuidance(0)).toContain("sparingly");
	});
});

describe("web_research tool definition", () => {
	it("registers the tool and the prompt section", async () => {
		const m = await mount("http://127.0.0.1:1", { budgetPerSession: 3 });
		expect(m.tools).toHaveLength(1);
		expect(m.tool.name).toBe("web_research");
		expect(m.tool.description).toMatch(/EXPENSIVE/u);
		expect(m.tool.description).toContain("web_search");
		expect(m.tool.parameters.question).toMatchObject({ type: "string", required: true });
		expect(m.tool.parameters.depth).toMatchObject({ type: "string", enum: ["mini", "pro"] });
		expect(m.tool.parameters.depth.required).toBeUndefined();
		expect(m.tool.isConcurrencySafe()).toBe(true);
		expect(m.sections).toEqual([expect.objectContaining({ name: WEB_RESEARCH_SECTION_NAME, order: WEB_RESEARCH_SECTION_ORDER })]);
		expect(m.sections[0].text).toContain("web_research");
		expect(m.sections[0].text).toContain("3 calls per session");
	});

	it("uses the DSL output schema (per-property required, no required array)", async () => {
		const m = await mount("http://127.0.0.1:1");
		const schema = m.tool.output.schema;
		expect(schema).not.toHaveProperty("required");
		expect(schema.properties.answer).toMatchObject({ type: "string", required: true });
		expect(schema.properties.sources).toMatchObject({ type: "array", required: true });
		expect(schema.properties.sources.items).not.toHaveProperty("required");
		expect(schema.properties.sources.items.properties.url).toMatchObject({ type: "string", required: true });
		expect(schema.properties.sources.items.properties.title.required).toBeUndefined();
		expect(schema.properties.truncated).toMatchObject({ type: "boolean", required: true });
		expect(schema.properties.requestId).toMatchObject({ type: "string", required: true });
		expect(schema.properties.notice.required).toBeUndefined();
	});

	it("tool timeout adds headroom above the polling deadline", () => {
		const def = buildWebResearchToolDefinition({ client: {}, config: () => ({}), budget: new SessionBudget(2), timeoutMs: 5_000 });
		expect(def.timeoutMs).toBe(15_000);
		const dflt = buildWebResearchToolDefinition({ client: {}, config: () => ({}), budget: new SessionBudget(2) });
		expect(dflt.timeoutMs).toBe(RESEARCH_DEFAULTS.timeoutMs + 10_000);
	});
});

describe("web_research execution", () => {
	it("happy path: POST then polls pending → in_progress → completed", async () => {
		server = await researchServer([{ status: "pending" }, { status: "in_progress" }, COMPLETED]);
		const m = await mount(server.baseURL);
		const value = await m.tool.execute({ question: "  What is X?  " }, exec());
		expect(value).toEqual({
			answer: "Answer body [1] and more [2].",
			sources: [{ url: "https://a.com/x", title: "A" }, { url: "https://b.com/y" }],
			truncated: false,
			requestId: "req-1",
		});

		const [post, ...gets] = server.requests;
		expect(post.method).toBe("POST");
		expect(post.url).toBe("/research");
		expect(post.headers.authorization).toBe("Bearer tvly-test");
		expect(post.body).toEqual({ input: "What is X?", model: "mini" });
		expect(gets).toHaveLength(3);
		for (const g of gets) {
			expect(g.method).toBe("GET");
			expect(g.url).toBe("/research/req-1");
			expect(g.headers.authorization).toBe("Bearer tvly-test");
			expect(g.body).toBeUndefined();
		}

		const [block] = m.tool.output.render({}, value);
		expect(block.type).toBe("text");
		expect(block.text).toBe("Answer body [1] and more [2].\n\nSources:\n1. A — https://a.com/x\n2. https://b.com/y");
		expect(m.tool.output.presentationMeta({}, value)).toMatchObject({ requestId: "req-1", sourceCount: 2, truncated: false });
	});

	it("depth=pro overrides the config model; invalid depth falls back", async () => {
		server = await researchServer([COMPLETED]);
		const m = await mount(server.baseURL, { model: "pro" });
		await m.tool.execute({ question: "q", depth: "mini" }, exec());
		await m.tool.execute({ question: "q", depth: "bogus" }, exec("s2"));
		const posts = server.requests.filter((r) => r.method === "POST").map((r) => r.body.model);
		expect(posts).toEqual(["mini", "pro"]);
	});

	it("rejects an empty question before spending budget or calling the API", async () => {
		server = await researchServer([COMPLETED]);
		const m = await mount(server.baseURL);
		await expect(m.tool.execute({ question: "   " }, exec())).rejects.toThrow(/non-empty/u);
		expect(server.requests).toHaveLength(0);
		expect(m.handles.budget.consume("s1").used).toBe(1);
	});

	it("failed status → WEB_PROVIDER_ERROR with the request id and detail", async () => {
		server = await researchServer([{ status: "pending" }, { status: "failed", error: "upstream exploded" }]);
		const m = await mount(server.baseURL);
		const err = await m.tool.execute({ question: "q" }, exec()).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toContain("req-1");
		expect(err.message).toContain('"failed"');
		expect(err.message).toContain("upstream exploded");
	});

	it("unknown terminal status is not polled further", async () => {
		server = await researchServer([{ status: "cancelled" }]);
		const m = await mount(server.baseURL);
		const err = await m.tool.execute({ question: "q" }, exec()).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toContain('"cancelled"');
		expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(1);
	});

	it("times out when the job stays pending past research.timeoutMs", async () => {
		server = await researchServer([{ status: "in_progress" }]);
		const m = await mount(server.baseURL, { pollIntervalMs: 20, timeoutMs: 400 });
		const t0 = Date.now();
		const err = await m.tool.execute({ question: "q" }, exec()).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/did not finish within 400 ms/u);
		expect(err.message).toContain("in_progress");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
		expect(server.requests.filter((r) => r.method === "GET").length).toBeGreaterThanOrEqual(2);
	});

	it("aborts between polls with WEB_ABORTED and stops polling", async () => {
		server = await researchServer([{ status: "pending" }]);
		const m = await mount(server.baseURL, { pollIntervalMs: 500, timeoutMs: 10_000 });
		const ac = new AbortController();
		const pending = m.tool.execute({ question: "q" }, exec("s1", ac.signal));
		await new Promise((r) => setTimeout(r, 60));
		ac.abort(new Error("user cancelled"));
		const err = await pending.catch((e) => e);
		expect(err.code).toBe("WEB_ABORTED");
		const gets = server.requests.filter((r) => r.method === "GET").length;
		await new Promise((r) => setTimeout(r, 100));
		expect(server.requests.filter((r) => r.method === "GET").length).toBe(gets);
	});

	it("a pre-aborted signal never calls the API", async () => {
		server = await researchServer([COMPLETED]);
		const m = await mount(server.baseURL);
		const err = await m.tool.execute({ question: "q" }, exec("s1", AbortSignal.abort())).catch((e) => e);
		expect(err.code).toBe("WEB_ABORTED");
		expect(server.requests).toHaveLength(0);
	});

	it("truncates long answers and caps sources", async () => {
		const sources = Array.from({ length: 15 }, (_, i) => ({ url: `https://s${i}.com`, title: `S${i}` }));
		server = await researchServer([{ ...COMPLETED, content: "x".repeat(100), sources }]);
		const m = await mount(server.baseURL, { maxAnswerChars: 40, maxSources: 3 });
		const value = await m.tool.execute({ question: "q" }, exec());
		expect(value.answer).toBe("x".repeat(40));
		expect(value.truncated).toBe(true);
		expect(value.notice).toMatch(/truncated.*40 chars/u);
		expect(value.sources).toHaveLength(3);
		const [block] = m.tool.output.render({}, value);
		expect(block.text).toContain("[truncated");
		expect(block.text).toContain("3. S2 — https://s2.com");
		expect(block.text).not.toContain("S3");
	});

	it("allows 2 calls per session then returns a budget notice without calling the API", async () => {
		server = await researchServer([COMPLETED]);
		const m = await mount(server.baseURL, { budgetPerSession: 2 });
		for (let i = 0; i < 2; i++) {
			const v = await m.tool.execute({ question: "q" }, exec("s1"));
			expect(v.notice).toBeUndefined();
			expect(v.requestId).toBe("req-1");
		}
		const postsBefore = server.requests.filter((r) => r.method === "POST").length;
		expect(postsBefore).toBe(2);

		const third = await m.tool.execute({ question: "q" }, exec("s1"));
		expect(third).toMatchObject({ answer: "", sources: [], truncated: false, requestId: "" });
		expect(third.notice).toMatch(/budget.*exhausted/u);
		expect(third.notice).toContain("2/2");
		expect(server.requests.filter((r) => r.method === "POST")).toHaveLength(2);
		expect(m.tool.output.render({}, third)[0].text).toBe(third.notice);
		expect(m.tool.output.presentationMeta({}, third)).toMatchObject({ budgetExhausted: true });

		const other = await m.tool.execute({ question: "q" }, exec("s2"));
		expect(other.notice).toBeUndefined();
	});

	it("propagates HTTP errors from the POST (401 → WEB_PROVIDER_ERROR)", async () => {
		server = await startServer((_req, _body, res) => json(res, 401, { detail: { error: "bad key" } }));
		const m = await mount(server.baseURL);
		const err = await m.tool.execute({ question: "q" }, exec()).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toContain("research");
		expect(err.message).toContain("TAVILY_API_KEY");
	});
});
