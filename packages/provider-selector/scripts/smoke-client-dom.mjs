// Manual smoke #2: full render of the ready state with a linkedom DOM + react-dom/client.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { parseHTML } = await import(pathToFileURL(new URL("../../fetch-readability/node_modules/linkedom/esm/index.js", import.meta.url).pathname.replace(/^\//, "")).href).catch(() => import(new URL("../../fetch-readability/node_modules/linkedom/esm/index.js", import.meta.url).href));
const D = "C:/Users/BAOSON/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/";
const req = createRequire(pathToFileURL(D + "x.js").href);
const { window, document } = parseHTML("<!doctype html><html><head></head><body><div id=root></div></body></html>");
globalThis.window = window; globalThis.document = document; 
globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node; globalThis.Element = window.Element;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = req("react");
const jsx = req("react/jsx-runtime");
const { createRoot } = req("react-dom/client");
const { act } = req("react");

const stub = (tag, name) => ({ children, icon, ...props }) => React.createElement(tag, { "data-prim": name, ...Object.fromEntries(Object.entries(props).filter(([k, v]) => typeof v !== "object")) }, children);
const primitives = { Button: stub("button", "Button"), Pill: stub("span", "Pill"), Input: ({ icon, className, ...rest }) => React.createElement("span", { className }, React.createElement("input", rest)), StateDot: ({ state }) => React.createElement("i", { "data-state": state }), Tooltip: ({ children }) => children, Menu: ({ anchor, open, items }) => React.createElement("span", { "data-prim": "Menu", "data-open": String(open), "data-items": items.length }, anchor), writeClipboard: async () => true };
const seed = { react: React, "react/jsx-runtime": jsx, "@deepseek-ai/dsh-client-ui-primitives": primitives };
let loaded;
window.__ModuleLoader__ = { load: (m) => { loaded = m; } };
new Function("window", readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"))(window);
const mod = loaded.factory((id) => seed[id]);


const listing = {
	search: [
		{ id: "tavily", kind: "search", label: "Tavily", providerKind: "llm-native", registered: true, available: true, usable: true, keyEnv: "TAVILY_API_KEY", keyConfigured: true, keySource: "file", mountedBackend: true },
		{ id: "deepseek-official", kind: "search", label: "DeepSeek (official)", providerKind: "model-embedded", registered: true, available: false, usable: false, keyEnv: "DEEPSEEK_API_KEY", keyConfigured: false },
		{ id: "mystery", kind: "search", label: "mystery", providerKind: "unknown", registered: true, available: true, usable: true },
	],
	fetch: [{ id: "readability-http", kind: "fetch", label: "Readability (HTTP)", providerKind: "fetch", registered: true, available: true, usable: true }],
	active: { search: "tavily", fetch: "readability-http" },
	catalog: [{ id: "exa", label: "Exa", kind: "llm-native", docsUrl: "https://docs.exa.ai", keyUrl: "https://dashboard.exa.ai", freeTier: "$10 credit", description: "Neural search.", keyEnv: "EXA_API_KEY", mounted: false, keyConfigured: false }],
	persisted: false,
	credentialsWritable: true,
};
const calls = [];
const registered = []; const dicts = {};
const fakeCtx = {
	effect: (fn) => fn(),
	locale: { register: (ns, d) => { dicts[ns] = d; }, bind: (ns) => (key, params) => (dicts[ns].en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(params?.[k])) },
	remote: { $mount: async () => {} },
	inject: (_names, fn) => fn(fakeCtx),
	get: () => ({
		list: async () => ({ ok: true, value: listing }),
		select: async (kind, id) => { calls.push(["select", kind, id]); listing.active[kind] = id; return { ok: true, value: { ok: true, active: listing.active } }; },
		setKey: async (ref, value) => { calls.push(["setKey", ref, value]); return { ok: true, value: { ok: true, ref } }; },
		unsetKey: async (ref) => { calls.push(["unsetKey", ref]); return { ok: true, value: { ok: true, ref } }; },
	}),
	slots: { inject: (_s, fn) => fn(), register: (decl, Component) => { registered.push({ decl, Component }); } },
};
await mod.apply(fakeCtx);
console.log("style injected:", document.querySelector('style[data-plugin="@baoson/dsh-web-provider-selector"]') !== null);
const { decl, Component } = registered[0];
const root = createRoot(document.getElementById("root"));
await act(async () => { root.render(React.createElement(Component, decl.inject())); });
await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const html = document.getElementById("root").innerHTML;
console.log("rows:", [...document.querySelectorAll("li.bwps-row")].map((e) => `${e.getAttribute("data-provider")}=${e.getAttribute("data-row-state")}`).join(" "));
console.log("active rows:", [...document.querySelectorAll("li.bwps-row[data-active=true]")].map((e) => e.getAttribute("data-provider")));
console.log("has notPersisted warning:", html.includes("only lasts for this run"));
console.log("tavily appears once:", document.querySelectorAll("[data-provider=tavily]").length === 1);
const useButtons = [...document.querySelectorAll("li.bwps-row button")].filter((b) => b.textContent === "Use");
console.log("Use buttons:", useButtons.map((b) => `${b.closest("li").getAttribute("data-provider")}:${b.hasAttribute("disabled") ? "disabled" : "enabled"}`));
// click "Use" on mystery
const mysteryUse = useButtons.find((b) => b.closest("li").getAttribute("data-provider") === "mystery");
await act(async () => { mysteryUse.click(); await new Promise((r) => setTimeout(r, 10)); });
console.log("calls after Use:", JSON.stringify(calls), "status:", document.querySelector("[role=status]")?.textContent);
// open key editor on deepseek-official, then on exa (only one expanded at a time)
const addKey = (id) => [...document.querySelectorAll(`li[data-provider=${id}] button`)].find((b) => b.textContent === "Add key");
await act(async () => { addKey("deepseek-official").click(); });
console.log("key editor shown (deepseek):", document.querySelector("li[data-provider=deepseek-official] .bwps-keyEditor") !== null);
await act(async () => { addKey("exa").click(); });
console.log("editors open:", document.querySelectorAll(".bwps-keyEditor").length, "on", document.querySelector(".bwps-keyEditor")?.closest("li").getAttribute("data-provider"));
console.log("exa status text:", document.querySelector("li[data-provider=exa] .bwps-rowStatus")?.textContent);
console.log("menus:", [...document.querySelectorAll("[data-prim=Menu]")].map((m) => `${m.closest("li").getAttribute("data-provider")}:${m.getAttribute("data-items")}`).join(" "));
// (Saving a key via linkedom is not exercised: React's controlled-input value tracker is not emulated there.)
process.exit(0);


