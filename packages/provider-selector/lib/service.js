/**
 * Host-side logic of the Web providers selector.
 *
 * Two layers live here so the package can be unit-tested without a DSH
 * install (the `@deepseek-ai/*` host packages are peers that only exist inside
 * `~/.dsh`):
 *
 * - {@link ProviderSelectorCore} — plain class; everything the UI needs
 *   (listing, live switching, persistence, credential writes) with injected
 *   dependencies.
 * - {@link defineWebProviderSelector} — given the real
 *   `@deepseek-ai/dsh-typert-protocol` exports, builds the cordis
 *   `TypertRemoteService` subclass (service key `webProviderSelector`, wire
 *   namespace `webProviders`) whose `@Remote` methods delegate to the core.
 *   Decorators are applied manually because this is plain JS.
 *
 * @module @tobedone4byme/dsh-web-provider-selector/service
 */
import { isVolatile } from "@tobedone4byme/dsh-web-shared/volatile";

/** Cordis service key the host service is registered under. */
export const SERVICE_KEY = "webProviderSelector";
/** Typert wire namespace: client calls `ctx.remote.webProviders.<method>()`. */
export const NAMESPACE = "webProviders";
/** Remote method names, in declaration order. */
export const REMOTE_METHODS = Object.freeze(["list", "select", "setKey", "unsetKey"]);

/** Same grammar as `@deepseek-ai/dsh-credentials` `credentialRef()`. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set(["search", "fetch"]);
/** `Symbol.for("cordis.original")` — unwraps a cordis traceable proxy to the service instance. */
const CORDIS_ORIGINAL = Symbol.for("cordis.original");

/**
 * Labels / key references for provider ids that are not in the `search-http`
 * catalog. Unknown ids are still listed, with the id as label.
 * @type {Record<string, { label: string, kind: string, keyEnv?: string, description?: string }>}
 */
export const KNOWN_PROVIDERS = Object.freeze({
	// search-http's tavily adapter ships no `meta` block yet; cover its display data here.
	tavily: {
		label: "Tavily",
		kind: "llm-native",
		keyEnv: "TAVILY_API_KEY",
		description: "LLM-native search: synthesized answer plus extracted passages per result.",
		docsUrl: "https://docs.tavily.com/",
		keyUrl: "https://app.tavily.com/",
		freeTier: "1,000 credits / month",
	},
	"deepseek-official": {
		label: "DeepSeek (official)",
		kind: "model-embedded",
		keyEnv: "DEEPSEEK_API_KEY",
		description: "Stock DSH search: deepseek-v4-flash with a server-side web search tool.",
	},
	"brave-search": {
		label: "Brave Search (legacy plugin)",
		kind: "engine",
		keyEnv: "BRAVE_SEARCH_API_KEY",
	},
	anthropic: {
		label: "Anthropic web search",
		kind: "model-embedded",
		keyEnv: "ANTHROPIC_API_KEY",
	},
	"readability-http": {
		label: "Readability (HTTP)",
		kind: "fetch",
		description: "SSRF-safe downloader + Mozilla Readability article extraction.",
	},
});

/**
 * @typedef {object} CoreDeps
 * @property {() => any} web                       Returns the live `ctx.web` runtime (`searchProviders`, `fetchProviders`, plus either
 *   the dsh >= 0.2 volatile `config.searchProvider/fetchProvider` or the legacy writable `searchProviderId/fetchProviderId`).
 * @property {() => any | undefined} [credentials]  Returns the `ctx.credentials` provider when mounted (`describe/set/unset`).
 * @property {() => Array<any>} [catalog]           Curated backend catalog (search-http `catalog()`).
 * @property {(patch: { searchProvider?: string, fetchProvider?: string }) => Promise<void>} [persist]
 *   Writes the selection to the settings store. On dsh >= 0.2 this MUST target the `web` entry (the runtime reads its own
 *   volatile Config on every call); on 0.1.x it targets this plugin's section. Absent → selection is live-only (0.1.x only).
 * @property {() => boolean} [canPersist]           Whether `persist` would currently succeed.
 * @property {(name: string) => string | undefined} [env]  Environment lookup for `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER`
 *   (the runtime's fallback when no id is configured). Defaults to `process.env`.
 */

/** Environment variables `@deepseek-ai/dsh-web` consults when its Config pins no provider. */
export const WEB_SEARCH_PROVIDER_ENV = "DSH_WEB_SEARCH_PROVIDER";
export const WEB_FETCH_PROVIDER_ENV = "DSH_WEB_FETCH_PROVIDER";

/** Unwrap a cordis traceable proxy so property writes land on the real instance. */
export function unwrapCordis(value) {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
	const original = value[CORDIS_ORIGINAL];
	return original !== undefined && original !== null ? original : value;
}

/** Drop `undefined` members — the typert gateway rejects them as non-JSON. */
function compact(object) {
	const out = {};
	for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
	return out;
}

/** Non-empty string or undefined. */
function text(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Merge a catalog row with static knowledge: the catalog wins when it carries
 * real metadata, `KNOWN_PROVIDERS` fills what an adapter left blank (search-http
 * falls back to `label = id`, empty strings for the rest).
 */
export function describeCatalogEntry(entry) {
	const known = KNOWN_PROVIDERS[entry.id] ?? {};
	// search-http emits `{ label: id, kind: "engine", docsUrl: "", … }` when an adapter has no `meta`.
	const bare = text(entry.label) === undefined || entry.label === entry.id;
	const pick = (value, fallback) => (bare ? fallback ?? text(value) : text(value) ?? fallback);
	return {
		id: entry.id,
		label: bare ? known.label ?? entry.id : entry.label,
		kind: pick(entry.kind, known.kind) ?? "engine",
		docsUrl: pick(entry.docsUrl, known.docsUrl) ?? "",
		keyUrl: pick(entry.keyUrl, known.keyUrl) ?? "",
		freeTier: pick(entry.freeTier, known.freeTier) ?? "",
		description: pick(entry.description, known.description) ?? "",
		// A key-less backend (e.g. self-hosted SearXNG) carries no key env at all,
		// so no row state or action can ever ask for a key.
		defaultApiKeyEnv: entry.requiresKey === false ? undefined : (text(entry.defaultApiKeyEnv) ?? known.keyEnv),
		requiresKey: entry.requiresKey !== false,
	};
}

/** Plain host logic; see module doc. */
export class ProviderSelectorCore {
	/** @param {CoreDeps} deps */
	constructor(deps) {
		if (typeof deps?.web !== "function") throw new TypeError("provider-selector: deps.web() is required");
		this.deps = deps;
	}

	get web() {
		const web = unwrapCordis(this.deps.web());
		if (web === undefined || web === null) throw new Error("provider-selector: ctx.web is unavailable");
		return web;
	}

	/**
	 * dsh >= 0.2: `WebRuntime` resolves the provider on every call from its own
	 * volatile Config (`config.searchProvider.get()`), so the `web` entry owns
	 * the selection and the legacy `searchProviderId` setters no longer exist.
	 */
	webOwnsSelection() {
		const config = this.web.config;
		return isVolatile(config?.searchProvider) && isVolatile(config?.fetchProvider);
	}

	env(name) {
		try {
			if (typeof this.deps.env === "function") return this.deps.env(name);
			return typeof process !== "undefined" ? process.env[name] : undefined;
		} catch {
			return undefined;
		}
	}

	/** Effective `{ search?, fetch? }` ids exactly as the runtime will resolve them on the next call. */
	activeIds() {
		const web = this.web;
		if (this.webOwnsSelection()) {
			return compact({
				search: text(web.config.searchProvider.get()) ?? text(this.env(WEB_SEARCH_PROVIDER_ENV)),
				fetch: text(web.config.fetchProvider.get()) ?? text(this.env(WEB_FETCH_PROVIDER_ENV)),
			});
		}
		return compact({ search: web.searchProviderId, fetch: web.fetchProviderId });
	}

	catalog() {
		try {
			return (this.deps.catalog?.() ?? []).map(describeCatalogEntry);
		} catch {
			return [];
		}
	}

	credentials() {
		try {
			return this.deps.credentials?.();
		} catch {
			return undefined;
		}
	}

	/**
	 * `{ configured, source?, writable }` for one credential reference, or
	 * `undefined` when no credentials service is mounted.
	 */
	async describeKey(ref) {
		const credentials = this.credentials();
		if (credentials === undefined || credentials === null) return undefined;
		try {
			const info = await credentials.describe(ref);
			return info === undefined ? undefined : compact({ configured: info.configured === true, source: info.source, writable: info.writable !== false });
		} catch {
			return undefined;
		}
	}

	/** Best-effort key reference for a registered provider instance. */
	keyEnvOf(provider, catalogEntry) {
		try {
			// `@tobedone4byme/dsh-web-search-http` providers expose their resolved options.
			if (typeof provider.resolveOptions === "function") {
				const env = provider.resolveOptions()?.apiKeyEnv;
				if (typeof env === "string" && env.length > 0) return env;
			}
		} catch {
			// fall through to static knowledge
		}
		if (typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.length > 0) return provider.apiKeyEnv;
		return KNOWN_PROVIDERS[provider.id]?.keyEnv ?? catalogEntry?.defaultApiKeyEnv;
	}

	async describeProvider(provider, kind, catalogById) {
		const id = String(provider.id);
		const catalogEntry = catalogById.get(id);
		const known = KNOWN_PROVIDERS[id];
		let available = false;
		try {
			available = provider.available() === true;
		} catch {
			available = false;
		}
		const keyEnv = this.keyEnvOf(provider, catalogEntry);
		const key = keyEnv === undefined ? undefined : await this.describeKey(keyEnv);
		const keyConfigured = key?.configured;
		// Providers that resolve keys through the credentials service report
		// `available()` optimistically; fold the real credential state in.
		const usable = available && (keyEnv === undefined || keyConfigured !== false);
		return compact({
			id,
			kind,
			label: catalogEntry?.label ?? known?.label ?? id,
			providerKind: catalogEntry?.kind ?? known?.kind ?? (kind === "fetch" ? "fetch" : "unknown"),
			description: text(catalogEntry?.description) ?? known?.description,
			registered: true,
			available,
			usable,
			keyEnv,
			keyConfigured,
			keySource: key?.source,
			keyWritable: key?.writable,
			mountedBackend: catalogEntry === undefined ? undefined : true,
		});
	}

	/** Everything the settings page renders in one round-trip. */
	async list() {
		const web = this.web;
		const catalog = this.catalog();
		const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
		const search = await Promise.all([...web.searchProviders.values()].map((p) => this.describeProvider(p, "search", catalogById)));
		const fetch = await Promise.all([...web.fetchProviders.values()].map((p) => this.describeProvider(p, "fetch", catalogById)));
		const catalogOut = await Promise.all(catalog.map(async (entry) => {
			const key = entry.defaultApiKeyEnv ? await this.describeKey(entry.defaultApiKeyEnv) : undefined;
			return compact({
				id: entry.id,
				label: entry.label ?? entry.id,
				kind: entry.kind ?? "engine",
				docsUrl: entry.docsUrl,
				keyUrl: entry.keyUrl,
				freeTier: entry.freeTier,
				description: entry.description,
				keyEnv: entry.defaultApiKeyEnv,
				requiresKey: entry.requiresKey,
				mounted: web.searchProviders.has(entry.id),
				keyConfigured: key?.configured,
				keySource: key?.source,
			});
		}));
		return {
			search,
			fetch,
			active: this.activeIds(),
			catalog: catalogOut,
			persisted: this.canPersist(),
			credentialsWritable: this.credentials() !== undefined && this.credentials() !== null,
		};
	}

	canPersist() {
		try {
			return this.deps.canPersist?.() ?? typeof this.deps.persist === "function";
		} catch {
			return false;
		}
	}

	/**
	 * Switch the active provider of one kind, then persist.
	 * dsh >= 0.2: the only way to switch is writing the `web` entry's Config
	 * (the runtime reads it on the next call), so persistence is mandatory.
	 * 0.1.x: set the runtime id live, then persist when possible.
	 * @param {"search"|"fetch"} kind
	 * @param {string} id registered provider id
	 */
	async select(kind, id) {
		if (!KINDS.has(kind)) throw new Error(`provider-selector: kind must be "search" or "fetch", got ${JSON.stringify(kind)}`);
		if (typeof id !== "string" || id.length === 0) throw new Error("provider-selector: id must be a non-empty string");
		const web = this.web;
		const store = kind === "search" ? web.searchProviders : web.fetchProviders;
		if (!store.has(id)) {
			const known = [...store.keys()].map((k) => `"${k}"`).join(", ") || "(none)";
			throw new Error(`provider-selector: no ${kind} provider "${id}" is registered; registered: ${known}`);
		}
		const patch = kind === "search" ? { searchProvider: id } : { fetchProvider: id };
		let persisted = false;
		if (this.webOwnsSelection()) {
			if (typeof this.deps.persist !== "function" || !this.canPersist()) {
				throw new Error("provider-selector: the settings service is unavailable or read-only; the web provider cannot be switched without writing the profile");
			}
			await this.deps.persist(patch);
			persisted = true;
		} else {
			if (kind === "search") web.searchProviderId = id;
			else web.fetchProviderId = id;
			if (typeof this.deps.persist === "function" && this.canPersist()) {
				await this.deps.persist(patch);
				persisted = true;
			}
		}
		return { ok: true, active: this.activeIds(), persisted };
	}

	/**
	 * Apply a persisted/base selection to the live runtime (boot + settings change) — 0.1.x only.
	 * On dsh >= 0.2 the `web` entry's own Config is the selection, so there is nothing to apply.
	 * Unknown ids are applied too — `dsh-web` reports CONFIGURED_MISSING itself.
	 */
	applySelection(selection) {
		const web = this.web;
		if (this.webOwnsSelection()) return;
		if (typeof selection?.searchProvider === "string" && selection.searchProvider.length > 0) web.searchProviderId = selection.searchProvider;
		if (typeof selection?.fetchProvider === "string" && selection.fetchProvider.length > 0) web.fetchProviderId = selection.fetchProvider;
	}

	requireCredentials() {
		const credentials = this.credentials();
		if (credentials === undefined || credentials === null) throw new Error("provider-selector: no credentials service is mounted (ctx.credentials); cannot store keys");
		return credentials;
	}

	static checkRef(ref) {
		if (typeof ref !== "string" || !CREDENTIAL_REF_PATTERN.test(ref)) throw new Error(`provider-selector: credential ref ${JSON.stringify(ref)} must be an environment-variable name like TAVILY_API_KEY`);
		return ref;
	}

	/** Store an API key under `ref` via `ctx.credentials.set` ($DSH_HOME/.credentials.yaml). */
	async setKey(ref, value) {
		ProviderSelectorCore.checkRef(ref);
		if (typeof value !== "string" || value.trim().length === 0) throw new Error("provider-selector: key value must be a non-empty string");
		await this.requireCredentials().set(ref, value.trim());
		return { ok: true, ref, key: (await this.describeKey(ref)) ?? { configured: true, writable: true } };
	}

	/** Remove the stored key for `ref` via `ctx.credentials.unset`. */
	async unsetKey(ref) {
		ProviderSelectorCore.checkRef(ref);
		await this.requireCredentials().unset(ref);
		return { ok: true, ref, key: (await this.describeKey(ref)) ?? { configured: false, writable: true } };
	}
}

/**
 * Build the cordis/typert service class from the real protocol exports.
 *
 * `Remote(name)` from `@deepseek-ai/dsh-typert-protocol` is a TC39 standard
 * method decorator: `(method, context) => void` that calls
 * `context.addInitializer(fn)`; `fn` runs with `this` = instance and marks the
 * prototype. We emulate the decorator context and run the initializers in the
 * constructor, exactly as TypeScript's `__runInitializers` would.
 *
 * NOTE: the API gateway's SRC fallback parses parameter names from
 * `Function.prototype.toString`, so the remote methods below MUST use plain
 * identifier parameters (no destructuring / defaults / rest).
 *
 * @param {{ TypertRemoteService: any, Remote: (name: string) => (method: any, context: any) => void }} protocol
 * @returns {any} the service class; `new Service(ctx, deps)`
 */
export function defineWebProviderSelector(protocol) {
	const { TypertRemoteService, Remote } = protocol;
	if (typeof TypertRemoteService !== "function" || typeof Remote !== "function") {
		throw new TypeError("provider-selector: defineWebProviderSelector needs { TypertRemoteService, Remote }");
	}
	/** @type {Array<() => void>} */
	const initializers = [];

	class WebProviderSelector extends TypertRemoteService {
		/**
		 * @param {any} ctx cordis context (owns the fiber the service rides)
		 * @param {CoreDeps} deps
		 */
		constructor(ctx, deps) {
			super(ctx, SERVICE_KEY, { namespace: NAMESPACE });
			this.core = deps instanceof ProviderSelectorCore ? deps : new ProviderSelectorCore(deps);
			for (const initializer of initializers) initializer.call(this);
		}

		list() {
			return this.core.list();
		}

		select(kind, id) {
			return this.core.select(kind, id);
		}

		setKey(ref, value) {
			return this.core.setKey(ref, value);
		}

		unsetKey(ref) {
			return this.core.unsetKey(ref);
		}
	}

	for (const method of REMOTE_METHODS) {
		const decorate = Remote(method);
		decorate(WebProviderSelector.prototype[method], {
			kind: "method",
			name: method,
			static: false,
			private: false,
			access: { has: (obj) => method in obj, get: (obj) => obj[method] },
			addInitializer: (fn) => {
				initializers.push(fn);
			},
		});
	}

	return WebProviderSelector;
}
