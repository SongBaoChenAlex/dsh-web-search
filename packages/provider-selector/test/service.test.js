import { describe, it, expect, beforeEach } from "vitest";
import { ProviderSelectorCore, defineWebProviderSelector, KNOWN_PROVIDERS, NAMESPACE, SERVICE_KEY, REMOTE_METHODS } from "../lib/service.js";
import { catalog } from "@tobedone4byme/dsh-web-search-http/adapter";

function provider(id, available, extra = {}) {
	return { id, available: () => available, ...extra };
}

function fakeCredentials(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		calls: [],
		async describe(ref) {
			const value = store.get(ref);
			return value ? { configured: true, source: "file", writable: true } : { configured: false, writable: true };
		},
		async set(ref, value) {
			this.calls.push(["set", ref, value]);
			store.set(ref, value);
		},
		async unset(ref) {
			this.calls.push(["unset", ref]);
			store.delete(ref);
		},
	};
}

function makeCtx() {
	const web = {
		searchProviders: new Map([
			["deepseek-official", provider("deepseek-official", true)],
			["tavily", provider("tavily", true, { resolveOptions: () => ({ apiKeyEnv: "TAVILY_API_KEY" }) })],
			["brave", provider("brave", false, { resolveOptions: () => ({ apiKeyEnv: "BRAVE_API_KEY" }) })],
		]),
		fetchProviders: new Map([["readability-http", provider("readability-http", true)]]),
		searchProviderId: "deepseek-official",
		fetchProviderId: undefined,
	};
	const credentials = fakeCredentials({ DEEPSEEK_API_KEY: "sk", TAVILY_API_KEY: "tvly" });
	const settings = { patches: [], writable: true };
	const core = new ProviderSelectorCore({
		web: () => web,
		credentials: () => credentials,
		catalog,
		canPersist: () => settings.writable,
		persist: async (patch) => { settings.patches.push(patch); },
	});
	return { web, credentials, settings, core };
}

describe("ProviderSelectorCore.list", () => {
	let ctx;
	beforeEach(() => { ctx = makeCtx(); });

	it("returns search/fetch/active/catalog with the documented shape", async () => {
		const listing = await ctx.core.list();
		expect(Object.keys(listing).sort()).toEqual(["active", "catalog", "credentialsWritable", "fetch", "persisted", "search"]);
		expect(listing.active).toEqual({ search: "deepseek-official" });
		expect(listing.persisted).toBe(true);
		expect(listing.credentialsWritable).toBe(true);
		expect(listing.search.map((p) => p.id)).toEqual(["deepseek-official", "tavily", "brave"]);
		expect(listing.fetch.map((p) => p.id)).toEqual(["readability-http"]);
		for (const p of [...listing.search, ...listing.fetch]) {
			expect(p.registered).toBe(true);
			expect(typeof p.available).toBe("boolean");
			expect(typeof p.label).toBe("string");
			expect(p.kind === "search" || p.kind === "fetch").toBe(true);
		}
	});

	it("labels known and catalog providers, falls back to id for unknown", async () => {
		ctx.web.searchProviders.set("mystery", provider("mystery", true));
		const { search, fetch } = await ctx.core.list();
		const byId = Object.fromEntries(search.map((p) => [p.id, p]));
		expect(byId["deepseek-official"].label).toBe(KNOWN_PROVIDERS["deepseek-official"].label);
		expect(byId["deepseek-official"].keyEnv).toBe("DEEPSEEK_API_KEY");
		expect(byId.tavily.label).toBe("Tavily");
		expect(byId.tavily.mountedBackend).toBe(true);
		expect(byId.mystery.label).toBe("mystery");
		expect(byId.mystery.keyEnv).toBeUndefined();
		expect(fetch[0].label).toBe(KNOWN_PROVIDERS["readability-http"].label);
		expect(fetch[0].keyEnv).toBeUndefined();
	});

	it("reports available / key flags and folds credential state into usable", async () => {
		const { search } = await ctx.core.list();
		const byId = Object.fromEntries(search.map((p) => [p.id, p]));
		expect(byId.tavily).toMatchObject({ available: true, keyConfigured: true, keySource: "file", usable: true });
		expect(byId.brave).toMatchObject({ available: false, keyEnv: "BRAVE_API_KEY", keyConfigured: false, usable: false });
		// optimistic available() but no key → not usable
		ctx.credentials.store.delete("TAVILY_API_KEY");
		const again = await ctx.core.list();
		expect(again.search.find((p) => p.id === "tavily")).toMatchObject({ available: true, keyConfigured: false, usable: false });
	});

	it("describes the catalog with mounted + key state", async () => {
		const { catalog: entries } = await ctx.core.list();
		const ids = entries.map((e) => e.id);
		expect(ids).toEqual(expect.arrayContaining(["tavily", "brave", "exa"]));
		const tavily = entries.find((e) => e.id === "tavily");
		expect(tavily).toMatchObject({ mounted: true, keyEnv: "TAVILY_API_KEY", keyConfigured: true });
		const exa = entries.find((e) => e.id === "exa");
		expect(exa.mounted).toBe(false);
		expect(exa.keyConfigured).toBe(false);
		for (const e of entries) for (const k of ["label", "kind", "docsUrl", "keyUrl", "freeTier", "description"]) expect(typeof e[k]).toBe("string");
	});

	it("never emits undefined members (JSON-safe for the gateway)", async () => {
		const listing = await ctx.core.list();
		expect(JSON.parse(JSON.stringify(listing))).toEqual(listing);
	});

	it("works without a credentials service", async () => {
		const core = new ProviderSelectorCore({ web: () => ctx.web, catalog });
		const listing = await core.list();
		expect(listing.credentialsWritable).toBe(false);
		expect(listing.persisted).toBe(false);
		expect(listing.search.find((p) => p.id === "tavily").keyConfigured).toBeUndefined();
	});
});

describe("ProviderSelectorCore.select", () => {
	it("sets the live id and persists the patch", async () => {
		const ctx = makeCtx();
		const result = await ctx.core.select("search", "tavily");
		expect(ctx.web.searchProviderId).toBe("tavily");
		expect(result).toEqual({ ok: true, active: { search: "tavily" }, persisted: true });
		expect(ctx.settings.patches).toEqual([{ searchProvider: "tavily" }]);

		await ctx.core.select("fetch", "readability-http");
		expect(ctx.web.fetchProviderId).toBe("readability-http");
		expect(ctx.settings.patches[1]).toEqual({ fetchProvider: "readability-http" });
	});

	it("rejects unknown ids and bad kinds without touching the runtime", async () => {
		const ctx = makeCtx();
		await expect(ctx.core.select("search", "nope")).rejects.toThrow(/no search provider "nope"/u);
		await expect(ctx.core.select("fetch", "tavily")).rejects.toThrow(/no fetch provider/u);
		await expect(ctx.core.select("other", "tavily")).rejects.toThrow(/kind/u);
		await expect(ctx.core.select("search", "")).rejects.toThrow(/non-empty/u);
		expect(ctx.web.searchProviderId).toBe("deepseek-official");
		expect(ctx.settings.patches).toEqual([]);
	});

	it("applies live even when settings are read-only, reporting persisted:false", async () => {
		const ctx = makeCtx();
		ctx.settings.writable = false;
		const result = await ctx.core.select("search", "brave");
		expect(ctx.web.searchProviderId).toBe("brave");
		expect(result.persisted).toBe(false);
		expect(ctx.settings.patches).toEqual([]);
	});

	it("applySelection re-applies persisted values and ignores empties", () => {
		const ctx = makeCtx();
		ctx.core.applySelection({ searchProvider: "tavily", fetchProvider: "" });
		expect(ctx.web.searchProviderId).toBe("tavily");
		expect(ctx.web.fetchProviderId).toBeUndefined();
	});

	it("unwraps a cordis traceable proxy so writes reach the real instance", async () => {
		const ctx = makeCtx();
		const real = ctx.web;
		const proxy = new Proxy({}, { get: (_t, prop) => (prop === Symbol.for("cordis.original") ? real : real[prop]), set: () => { throw new Error("proxy write"); } });
		const core = new ProviderSelectorCore({ web: () => proxy, catalog });
		await core.select("search", "tavily");
		expect(real.searchProviderId).toBe("tavily");
	});
});

/** A dsh >= 0.2 `WebRuntime`: selection lives in its volatile Config, no `*ProviderId` setters. */
function volatileRef(initial) {
	let current = initial;
	return Object.freeze({ get: () => current, [Symbol.for("cosmokit.volatile.write")]: (next) => { current = next; } });
}

function makeCtx02({ search = "deepseek-official", fetch = undefined, env = {} } = {}) {
	const base = makeCtx();
	// `undefined` must stay undefined ("nothing pinned"), so read the raw option instead of the defaulted one.
	const pinned = arguments[0] && "search" in arguments[0] ? arguments[0].search : search;
	const config = { searchProvider: volatileRef(pinned), fetchProvider: volatileRef(fetch) };
	const web = { searchProviders: base.web.searchProviders, fetchProviders: base.web.fetchProviders, config };
	const writes = [];
	const settings = { writable: true };
	const core = new ProviderSelectorCore({
		web: () => web,
		credentials: () => base.credentials,
		catalog,
		env: (name) => env[name],
		canPersist: () => settings.writable,
		// Emulate SettingsForms.update on the `web` entry: the loader then updates the refs in place.
		persist: async (patch) => {
			writes.push(patch);
			for (const [key, value] of Object.entries(patch)) config[key][Symbol.for("cosmokit.volatile.write")](value);
		},
	});
	return { web, config, writes, settings, core };
}

describe("ProviderSelectorCore on dsh >= 0.2 (web entry owns the selection)", () => {
	it("detects the volatile Config and reports active ids from it", async () => {
		const ctx = makeCtx02({ fetch: "readability-http" });
		expect(ctx.core.webOwnsSelection()).toBe(true);
		expect(makeCtx().core.webOwnsSelection()).toBe(false);
		expect((await ctx.core.list()).active).toEqual({ search: "deepseek-official", fetch: "readability-http" });
	});

	it("falls back to $DSH_WEB_*_PROVIDER when the Config pins nothing, like the runtime does", async () => {
		const ctx = makeCtx02({ search: undefined, env: { DSH_WEB_SEARCH_PROVIDER: "tavily" } });
		expect((await ctx.core.list()).active).toEqual({ search: "tavily" });
	});

	it("select() writes the web entry patch and never touches legacy setters", async () => {
		const ctx = makeCtx02();
		const result = await ctx.core.select("search", "tavily");
		expect(ctx.writes).toEqual([{ searchProvider: "tavily" }]);
		expect(ctx.config.searchProvider.get()).toBe("tavily");
		expect(result).toEqual({ ok: true, active: { search: "tavily" }, persisted: true });
		expect("searchProviderId" in ctx.web).toBe(false);

		await ctx.core.select("fetch", "readability-http");
		expect(ctx.writes[1]).toEqual({ fetchProvider: "readability-http" });
		expect((await ctx.core.list()).active).toEqual({ search: "tavily", fetch: "readability-http" });
	});

	it("select() refuses when the profile is read-only instead of pretending to switch", async () => {
		const ctx = makeCtx02();
		ctx.settings.writable = false;
		await expect(ctx.core.select("search", "tavily")).rejects.toThrow(/read-only|unavailable/u);
		expect(ctx.config.searchProvider.get()).toBe("deepseek-official");
		expect(ctx.writes).toEqual([]);
	});

	it("applySelection() is a no-op because the web entry is the selection", () => {
		const ctx = makeCtx02();
		ctx.core.applySelection({ searchProvider: "tavily" });
		expect(ctx.config.searchProvider.get()).toBe("deepseek-official");
		expect("searchProviderId" in ctx.web).toBe(false);
	});
});

describe("ProviderSelectorCore keys", () => {
	it("setKey stores through credentials.set and reports configured", async () => {
		const ctx = makeCtx();
		const result = await ctx.core.setKey("EXA_API_KEY", "  exa-123 ");
		expect(ctx.credentials.calls).toEqual([["set", "EXA_API_KEY", "exa-123"]]);
		expect(result).toEqual({ ok: true, ref: "EXA_API_KEY", key: { configured: true, source: "file", writable: true } });
	});

	it("unsetKey removes through credentials.unset", async () => {
		const ctx = makeCtx();
		const result = await ctx.core.unsetKey("TAVILY_API_KEY");
		expect(ctx.credentials.calls).toEqual([["unset", "TAVILY_API_KEY"]]);
		expect(result.key.configured).toBe(false);
	});

	it("validates refs and values", async () => {
		const ctx = makeCtx();
		await expect(ctx.core.setKey("not a ref", "x")).rejects.toThrow(/environment-variable name/u);
		await expect(ctx.core.setKey("TAVILY_API_KEY", "   ")).rejects.toThrow(/non-empty/u);
		await expect(ctx.core.unsetKey("")).rejects.toThrow(/environment-variable name/u);
		expect(ctx.credentials.calls).toEqual([]);
	});

	it("fails clearly without a credentials service", async () => {
		const core = new ProviderSelectorCore({ web: () => makeCtx().web });
		await expect(core.setKey("X_KEY", "v")).rejects.toThrow(/no credentials service/u);
	});
});

describe("defineWebProviderSelector", () => {
	/** Fake of @deepseek-ai/dsh-typert-protocol: same decorator protocol, records markers. */
	function fakeProtocol() {
		const markers = new Map();
		class Service {
			constructor(ctx, name) { this.ctx = ctx; this.name = name; ctx.provided.push(name); }
		}
		class TypertRemoteService extends Service {
			constructor(ctx, key, options = {}) {
				super(ctx, key);
				this.typertRemote = Object.freeze({ service: this, serviceKey: key, namespace: options.namespace ?? key });
			}
		}
		function Remote(exportName) {
			return function (_method, context) {
				context.addInitializer(function () {
					const proto = Object.getPrototypeOf(this);
					if (!markers.has(proto)) markers.set(proto, new Map());
					markers.get(proto).set(context.name, { exportName, invocation: { kind: "direct" } });
				});
			};
		}
		return { TypertRemoteService, Remote, markers };
	}

	it("builds a service bound to the webProviders namespace with all four Remote markers", async () => {
		const protocol = fakeProtocol();
		const Service = defineWebProviderSelector(protocol);
		const ctx = makeCtx();
		const cordis = { provided: [] };
		const instance = new Service(cordis, { web: () => ctx.web, credentials: () => ctx.credentials, catalog, persist: async () => {} });
		expect(cordis.provided).toEqual([SERVICE_KEY]);
		expect(instance.typertRemote).toEqual({ service: instance, serviceKey: SERVICE_KEY, namespace: NAMESPACE });
		const marked = protocol.markers.get(Object.getPrototypeOf(instance));
		expect([...marked.keys()]).toEqual([...REMOTE_METHODS]);
		expect(marked.get("select").exportName).toBe("select");
		// remote methods delegate to the core
		const listing = await instance.list();
		expect(listing.active.search).toBe("deepseek-official");
		await instance.select("search", "tavily");
		expect(ctx.web.searchProviderId).toBe("tavily");
	});

	it("uses plain identifier parameters (the gateway SRC fallback parses them from source)", () => {
		const Service = defineWebProviderSelector(fakeProtocol());
		const expected = { list: [], select: ["kind", "id"], setKey: ["ref", "value"], unsetKey: ["ref"] };
		for (const [method, names] of Object.entries(expected)) {
			const source = Function.prototype.toString.call(Service.prototype[method]);
			const params = source.slice(source.indexOf("(") + 1, source.indexOf(")")).split(",").map((s) => s.trim()).filter(Boolean);
			expect(params).toEqual(names);
		}
	});

	it("keeps the client descriptor wire names in sync with the host signatures", async () => {
		const { TYPERT_REMOTE } = await import("../lib/typert.remote-client.js");
		expect(TYPERT_REMOTE.package).toBe("@tobedone4byme/dsh-web-provider-selector");
		const byMethod = Object.fromEntries(TYPERT_REMOTE.descriptors.map((d) => [d.method, d]));
		expect(Object.keys(byMethod).sort()).toEqual([...REMOTE_METHODS].sort());
		for (const d of TYPERT_REMOTE.descriptors) {
			expect(d.namespace).toBe(NAMESPACE);
			expect(d.service).toBe(SERVICE_KEY);
			expect(d.invocation).toEqual({ kind: "direct" });
			expect(d.result.mode).toBe("strict");
			expect(typeof d.result.schema.parse).toBe("function");
			for (const p of d.parameters) expect(p.codec.mode).toBe("strict");
		}
		expect(byMethod.select.parameters.map((p) => p.wire)).toEqual(["kind", "id"]);
		expect(byMethod.setKey.parameters.map((p) => p.wire)).toEqual(["ref", "value"]);
		expect(() => byMethod.select.parameters[0].codec.schema.parse("other")).toThrow();
		expect(byMethod.select.parameters[0].codec.schema.parse("fetch")).toBe("fetch");
	});
});
