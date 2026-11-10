import { describe, it, expect } from "vitest";
import { mergeRows, mountSnippet, rowAction, rowState } from "../src/client/rows.js";

const listing = {
	search: [
		{ id: "tavily", kind: "search", label: "Tavily", providerKind: "llm-native", registered: true, available: true, usable: true, keyEnv: "TAVILY_API_KEY", keyConfigured: true, keySource: "file" },
		{ id: "deepseek-official", kind: "search", label: "DeepSeek (official)", providerKind: "model-embedded", registered: true, available: false, usable: false, keyEnv: "DEEPSEEK_API_KEY", keyConfigured: false },
		{ id: "mystery", kind: "search", label: "mystery", providerKind: "unknown", registered: true, available: true, usable: true },
		{ id: "broken", kind: "search", label: "broken", providerKind: "unknown", registered: true, available: false, usable: false },
	],
	fetch: [{ id: "readability-http", kind: "fetch", label: "Readability (HTTP)", providerKind: "fetch", registered: true, available: true, usable: true }],
	active: { search: "tavily", fetch: "readability-http" },
	catalog: [
		{ id: "tavily", label: "Tavily", kind: "llm-native", docsUrl: "https://docs.tavily.com", keyUrl: "https://app.tavily.com", freeTier: "1000/mo", keyEnv: "TAVILY_API_KEY", mounted: true, keyConfigured: true },
		{ id: "exa", label: "Exa", kind: "llm-native", docsUrl: "https://docs.exa.ai", keyUrl: "https://dashboard.exa.ai", freeTier: "$10 credit", description: "Neural search.", keyEnv: "EXA_API_KEY", mounted: false, keyConfigured: false },
	],
};

describe("mergeRows", () => {
	const rows = mergeRows(listing);

	it("lists each id exactly once, registered row first", () => {
		const ids = rows.search.map((r) => r.id);
		expect(ids).toEqual(["tavily", "deepseek-official", "mystery", "broken", "exa"]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("merges catalog metadata into the registered twin", () => {
		const tavily = rows.search[0];
		expect(tavily.registered).toBe(true);
		expect(tavily.docsUrl).toBe("https://docs.tavily.com");
		expect(tavily.keyUrl).toBe("https://app.tavily.com");
		expect(tavily.freeTier).toBe("1000/mo");
		expect(tavily.keySource).toBe("file");
	});

	it("derives the state machine", () => {
		const byId = Object.fromEntries(rows.search.map((r) => [r.id, r]));
		expect(byId.tavily).toMatchObject({ state: "active", dot: "on", action: null, active: true });
		expect(byId.mystery).toMatchObject({ state: "usable", dot: "on", action: "use" });
		expect(byId["deepseek-official"]).toMatchObject({ state: "keyMissing", dot: "off", action: "addKey" });
		expect(byId.broken).toMatchObject({ state: "unavailable", dot: "off", action: null });
		expect(byId.exa).toMatchObject({ state: "catalog", dot: "off", action: "addKey", registered: false, kind: "search", keyEnv: "EXA_API_KEY" });
		expect(rows.fetch[0]).toMatchObject({ state: "active", kind: "fetch" });
	});

	it("keeps catalog entries out of the fetch table", () => {
		expect(rows.fetch.map((r) => r.id)).toEqual(["readability-http"]);
	});

	it("tolerates a sparse listing", () => {
		expect(mergeRows({})).toEqual({ search: [], fetch: [] });
		expect(mergeRows({ catalog: [{ id: "exa" }] }).search[0]).toMatchObject({ id: "exa", label: "exa", state: "catalog", action: null });
	});
});

describe("rowState / rowAction", () => {
	it("prefers active over everything for registered rows", () => {
		expect(rowState({ registered: true, available: false, keyEnv: "X", keyConfigured: false }, true)).toBe("active");
	});
	it("treats a registered provider with a configured key but available=false as unavailable", () => {
		expect(rowState({ registered: true, available: false, keyEnv: "X", keyConfigured: true }, false)).toBe("unavailable");
	});
	it("gives no action when a key env is unknown", () => {
		expect(rowAction("catalog", {})).toBe(null);
		expect(rowAction("unavailable", { keyEnv: "X" })).toBe(null);
	});
});

describe("mountSnippet", () => {
	it("renders the composition row", () => {
		expect(mountSnippet({ id: "exa", keyEnv: "EXA_API_KEY" })).toBe(
			'- id: web-search-exa\n  name: "@tobedone4byme/dsh-web-search-http"\n  config: { backend: exa, apiKeyEnv: EXA_API_KEY }',
		);
	});
	it("derives a key env when none is known", () => {
		expect(mountSnippet({ id: "you-com" })).toContain("apiKeyEnv: YOU_COM_API_KEY");
	});
});
