// Manual smoke: load lib/client.js under a fake window.__ModuleLoader__ with
// stub shell modules, run apply() against a fake client cordis, and render
// the section with react-dom/server using fake remote results.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const D = "C:/Users/BAOSON/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/";
const req = createRequire(pathToFileURL(D + "x.js").href);
const React = req("react");
const jsx = req("react/jsx-runtime");
const ReactDOMServer = req("react-dom/server");

const stub = (name) => (props) => React.createElement(name === "Input" ? "input" : name === "Button" || name === "Pill" ? "button" : "span", { "data-prim": name, ...Object.fromEntries(Object.entries(props).filter(([k]) => typeof props[k] !== "function" && k !== "children" && k !== "icon")) }, props.children);
const primitives = { Button: stub("Button"), Pill: stub("Pill"), Input: stub("Input"), StateDot: stub("StateDot"), Tooltip: ({ children }) => children };
const seed = { react: React, "react/jsx-runtime": jsx, "@deepseek-ai/dsh-client-ui-primitives": primitives };

let loaded;
globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m; } } };
globalThis.document = undefined;
new Function(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"))();
const mod = loaded.factory((id) => { if (!(id in seed)) throw new Error("unexpected require " + id); return seed[id]; });
console.log("module id:", loaded.id, "exports:", Object.keys(mod), "inject:", mod.inject);

const listing = {
	search: [
		{ id: "tavily", kind: "search", label: "Tavily", providerKind: "llm-native", registered: true, available: true, usable: true, keyEnv: "TAVILY_API_KEY", keyConfigured: true, keySource: "file", mountedBackend: true },
		{ id: "deepseek-official", kind: "search", label: "DeepSeek (official)", providerKind: "model-embedded", registered: true, available: false, usable: false, keyEnv: "DEEPSEEK_API_KEY", keyConfigured: false },
	],
	fetch: [{ id: "readability-http", kind: "fetch", label: "Readability (HTTP)", providerKind: "fetch", registered: true, available: true, usable: true }],
	active: { search: "tavily", fetch: "readability-http" },
	catalog: [{ id: "exa", label: "Exa", kind: "llm-native", docsUrl: "https://docs.exa.ai", keyUrl: "https://dashboard.exa.ai", freeTier: "$10 credit", description: "Neural search.", keyEnv: "EXA_API_KEY", mounted: false, keyConfigured: false }],
	persisted: true,
	credentialsWritable: true,
};
const registered = [];
const dicts = {};
const fakeCtx = {
	effect: (fn) => fn(),
	locale: { register: (ns, d) => { dicts[ns] = d; }, bind: (ns) => (key, params) => (dicts[ns].en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(params?.[k])) },
	remote: { $mount: async (contribution) => { console.log("mounted descriptors:", contribution.descriptors.map((d) => d.method)); } },
	inject: (names, fn) => { console.log("inject scope:", names); fn(fakeCtx); },
	get: (name) => ({ list: async () => ({ ok: true, value: listing }), select: async () => ({ ok: true, value: { ok: true, active: {} } }) }),
	slots: { inject: (slot, fn) => fn(), register: (decl, Component) => { registered.push({ decl, Component }); } },
};
await mod.apply(fakeCtx);
const { decl, Component } = registered[0];
console.log("slot:", decl.name, decl.id, decl.order, decl.label());
// Render with pre-resolved data by monkeypatching useState? Simpler: render and check the loading state, then render body via the api.
const html = ReactDOMServer.renderToStaticMarkup(React.createElement(Component, decl.inject()));
console.log("initial html:", html.slice(0, 200));
console.log("zh/en key parity:", JSON.stringify(Object.keys(dicts["settings.webProviders"].zh).sort()) === JSON.stringify(Object.keys(dicts["settings.webProviders"].en).sort()));
