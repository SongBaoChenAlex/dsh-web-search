// Manual smoke (not a vitest test — needs the DSH install): wires the real cordis
// Context, typert registry, api-gateway, and our service, then dispatches
// `webProviders/list` and `webProviders/select` through the gateway SRC fallback.
import { pathToFileURL } from "node:url";
const D = "C:/Users/BAOSON/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/";
const load = (p) => import(pathToFileURL(D + p).href);
const { Context } = await load("cordis/lib/index.js");
const protocol = await load("dsh-typert-protocol/lib/index.js");
const gatewayMod = await load("dsh-api-gateway/lib/index.js");
const registryMod = await load("dsh-typert-registry/lib/index.js");
const { defineWebProviderSelector, ProviderSelectorCore } = await import("../lib/service.js");
const { catalog } = await import("@tobedone4byme/dsh-web-search-http/adapter");

const ctx = new Context();
const web = {
	searchProviders: new Map([["tavily", { id: "tavily", available: () => true }], ["deepseek-official", { id: "deepseek-official", available: () => true }]]),
	fetchProviders: new Map(),
	searchProviderId: "deepseek-official",
	fetchProviderId: undefined,
};
ctx.provide("web", web);
ctx.plugin(registryMod.default ?? registryMod.TypertRegistry);
ctx.plugin(gatewayMod.default);
const Service = defineWebProviderSelector(protocol);
const patches = [];
ctx.plugin({
	name: "web-provider-selector",
	inject: ["web"],
	apply(pctx) {
		new Service(pctx, new ProviderSelectorCore({ web: () => pctx.web, catalog, persist: async (p) => { patches.push(p); } }));
	},
});
await new Promise((r) => setTimeout(r, 50));
const gateway = ctx.get("typertGateway");
console.log("claims list:", gateway.claimsEndpoint("webProviders/list"));
const listing = await gateway.invokeRpc("webProviders/list", { args: {} });
console.log("list:", JSON.stringify(listing).slice(0, 300));
const sel = await gateway.invokeRpc("webProviders/select", { args: { kind: "search", id: "tavily" } });
console.log("select:", JSON.stringify(sel), "live id:", web.searchProviderId, "patches:", JSON.stringify(patches));
const bad = await gateway.invokeRpc("webProviders/select", { args: { kind: "search", id: "nope" } });
console.log("bad select:", JSON.stringify(bad));
process.exit(0);
