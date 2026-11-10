import { describe, it, expect } from "vitest";
import { applyWith, Config, name, inject, TAVILY_EXTRACT_PROVIDER_ID, SETTINGS_NAMESPACE, resolveClientOptions } from "../lib/index.js";
import { TAVILY_ENDPOINTS } from "../lib/client-api.js";

function fakeCtx() {
	const fetchProviders = [];
	const tools = [];
	const sections = [];
	return {
		ctx: {
			web: { registerFetchProvider(p) { fetchProviders.push(p); } },
			tools: { register(t) { tools.push(t); } },
			systemPrompt: { section(s) { sections.push(s); } },
			get() { return undefined; },
			logger: { warn() {}, debug() {} },
		},
		fetchProviders, tools, sections,
	};
}

describe("plugin surface", () => {
	it("exports cordis metadata and defaults", () => {
		expect(name).toBe("web-tavily-tools");
		expect(inject).toEqual(["web", "tools", "systemPrompt"]);
		expect(SETTINGS_NAMESPACE).toBe("web-tavily-tools");
		const cfg = new Config({});
		expect(cfg.apiKeyEnv).toBe("TAVILY_API_KEY");
		expect(cfg.baseURL).toBe("https://api.tavily.com");
		expect(cfg.timeoutMs).toBe(30_000);
		expect(cfg.extract).toMatchObject({ enabled: true, depth: "basic", maxOutputChars: 20_000 });
		expect(cfg.map).toMatchObject({ enabled: true, budgetPerSession: 5, defaultLimit: 30, maxLimit: 100 });
		expect(cfg.research).toMatchObject({ enabled: true, model: "mini", pollIntervalMs: 2000, timeoutMs: 120_000, maxAnswerChars: 6000, maxSources: 10, budgetPerSession: 2 });
	});
	it("rejects an invalid research model", () => {
		expect(() => new Config({ research: { model: "ultra" } })).toThrow();
	});
	it("rejects an invalid extract depth", () => {
		expect(() => new Config({ extract: { depth: "deep" } })).toThrow();
	});
	it("resolveClientOptions falls back to defaults for blank strings", () => {
		const o = resolveClientOptions({ get: () => undefined }, { apiKeyEnv: " ", baseURL: "" });
		expect(o.apiKeyEnv).toBe("TAVILY_API_KEY");
		expect(o.baseURL).toBe("https://api.tavily.com");
		expect(o.timeoutMs).toBe(30_000);
	});
});

describe("apply", () => {
	it("registers the fetch provider, the web_map tool and the prompt section", async () => {
		const f = fakeCtx();
		const config = new Config({ apiKey: "tvly-x" });
		const r = await applyWith(f.ctx, config, { defineTool: (d) => d });
		expect(f.fetchProviders).toHaveLength(1);
		expect(f.fetchProviders[0].id).toBe(TAVILY_EXTRACT_PROVIDER_ID);
		expect(f.fetchProviders[0].available()).toBe(true);
		expect(f.tools.map((t) => t.name)).toEqual(["web_map", "web_research"]);
		expect(f.sections.map((s) => s.name)).toEqual(["tool:web_map", "tool:web_research"]);
		expect(r.provider).toBe(f.fetchProviders[0]);
		expect(r.research.tool.name).toBe("web_research");
	});

	it("extract.enabled:false skips the provider but keeps the tools", async () => {
		const f = fakeCtx();
		await applyWith(f.ctx, new Config({ extract: { enabled: false } }), { defineTool: (d) => d });
		expect(f.fetchProviders).toHaveLength(0);
		expect(f.tools).toHaveLength(2);
	});

	it("map.enabled:false skips the tool and section but keeps the provider", async () => {
		const f = fakeCtx();
		await applyWith(f.ctx, new Config({ map: { enabled: false } }), { defineTool: (d) => d });
		expect(f.fetchProviders).toHaveLength(1);
		expect(f.tools.map((t) => t.name)).toEqual(["web_research"]);
		expect(f.sections.map((s) => s.name)).toEqual(["tool:web_research"]);
	});

	it("research.enabled:false skips web_research only", async () => {
		const f = fakeCtx();
		const r = await applyWith(f.ctx, new Config({ research: { enabled: false } }), { defineTool: (d) => d });
		expect(f.tools.map((t) => t.name)).toEqual(["web_map"]);
		expect(f.sections.map((s) => s.name)).toEqual(["tool:web_map"]);
		expect(r.research).toBeUndefined();
	});

	it("provider is unavailable without a key source", async () => {
		const f = fakeCtx();
		const saved = process.env.TAVILY_API_KEY;
		delete process.env.TAVILY_API_KEY;
		try {
			await applyWith(f.ctx, new Config({}), { defineTool: (d) => d });
			expect(f.fetchProviders[0].available()).toBe(false);
		} finally {
			if (saved !== undefined) process.env.TAVILY_API_KEY = saved;
		}
	});
});

describe("client-api catalogue", () => {
	it("describes all Tavily endpoints", () => {
		expect(TAVILY_ENDPOINTS.map((e) => e.id)).toEqual(["search", "extract", "map", "crawl", "research", "research-status"]);
		expect(TAVILY_ENDPOINTS.find((e) => e.id === "extract").implementedBy).toContain("tavily-extract");
		expect(TAVILY_ENDPOINTS.find((e) => e.id === "map").implementedBy).toBe("web_map tool");
		expect(TAVILY_ENDPOINTS.find((e) => e.id === "research").implementedBy).toBe("web_research tool");
		expect(TAVILY_ENDPOINTS.find((e) => e.id === "crawl").implementedBy).toBeNull();
	});
});
