/**
 * Generic HTTP web-search provider for the DeepSeek Harness web seam (`ctx.web`).
 *
 * One plugin, pluggable backends: the `backend` config picks an adapter from
 * `./adapter.js` (`tavily`, `brave`, `exa`, `serper`, `jina`, `searxng`), and the provider registers under that
 * backend's id, so `searchProvider: tavily` in the `web` row selects it.
 * Credential resolution, timeouts, abort handling and `WebError` mapping are
 * shared here; adapters only describe request/response shapes.
 *
 * `WebError` comes from `@deepseek-ai/dsh-web` through the shared `webError()`
 * helper (lazy import with a same-shape fallback) so unit tests can run outside
 * a DSH install. Codes used: `WEB_PROVIDER_ERROR`,
 * `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_ABORTED`.
 *
 * @module @baoson/dsh-web-search-http
 */
import z from "@deepseek-ai/schemastery";
import { liveConfig } from "@baoson/dsh-web-shared/settings";
import { apiKeyResolver } from "@baoson/dsh-web-shared/credentials";
import { fetchWithTimeout, abortable, isAbortError, webError, bindHost } from "@baoson/dsh-web-shared/http";
import { getAdapter, adapters } from "./adapter.js";
import { TAVILY_DEFAULTS, TAVILY_ID } from "./adapters/tavily.js";
import { BRAVE_DEFAULTS, BRAVE_ID } from "./adapters/brave.js";
import { EXA_DEFAULTS, EXA_ID } from "./adapters/exa.js";
import { SERPER_DEFAULTS, SERPER_ID } from "./adapters/serper.js";
import { JINA_DEFAULTS, JINA_ID } from "./adapters/jina.js";
import { SEARXNG_DEFAULTS, SEARXNG_ID } from "./adapters/searxng.js";

export { adapters, getAdapter, catalog } from "./adapter.js";

/** Provider id registered when `backend: tavily` (the default). */
export const TAVILY_PROVIDER_ID = TAVILY_ID;
export const BRAVE_PROVIDER_ID = BRAVE_ID;
export const EXA_PROVIDER_ID = EXA_ID;
export const SERPER_PROVIDER_ID = SERPER_ID;
export const JINA_PROVIDER_ID = JINA_ID;
export const SEARXNG_PROVIDER_ID = SEARXNG_ID;

const DEFAULT_BACKEND = TAVILY_ID;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 5;
/** Absolute ceiling regardless of what the tool asks for. */
const HARD_MAX_RESULTS = 20;
const USER_AGENT = "dsh-web-search-http/0.1.0";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-http";
/** The web seam this provider registers into. */
export const inject = ["web"];

export const Config = z.object({
	backend: z.string().default(DEFAULT_BACKEND).description("Adapter to use; also becomes the provider id (e.g. `tavily`)."),
	apiKey: z.string().role("secret").description("Literal API key. Prefer `apiKeyEnv`."),
	apiKeyEnv: z.string().role("credential-ref").description("Credential / environment variable name holding the key. Defaults to the backend's convention (Tavily: TAVILY_API_KEY)."),
	baseURL: z.string().description("Endpoint base URL. Defaults to the backend's public endpoint."),
	timeoutMs: z.number().step(1).min(0).default(DEFAULT_TIMEOUT_MS).description("Per-request timeout in ms; 0 disables."),
	maxResults: z.number().step(1).min(1).max(HARD_MAX_RESULTS).default(DEFAULT_MAX_RESULTS).description("Results per search when the tool does not ask for a number."),
	tavily: z.object({
		searchDepth: z.union(["basic", "advanced"]).default(TAVILY_DEFAULTS.searchDepth).description("`advanced` costs 2 credits per search."),
		includeAnswer: z.boolean().default(TAVILY_DEFAULTS.includeAnswer).description("Ask Tavily for a synthesized answer (mapped to the result's `content`)."),
		includeRawContent: z.boolean().default(TAVILY_DEFAULTS.includeRawContent).description("Full pages are web_fetch's job; leave false."),
		topic: z.union(["general", "news"]).default(TAVILY_DEFAULTS.topic),
		includeDomains: z.array(z.string()).default([]),
		excludeDomains: z.array(z.string()).default([]),
	}).default({ ...TAVILY_DEFAULTS, includeDomains: [], excludeDomains: [] }),
	brave: z.object({
		country: z.string().default(BRAVE_DEFAULTS.country).description("2-letter country code, e.g. US, CN."),
		searchLang: z.string().default(BRAVE_DEFAULTS.searchLang).description("Language code, e.g. en, zh-hans."),
		safesearch: z.union(["off", "moderate", "strict"]).default(BRAVE_DEFAULTS.safesearch),
		freshness: z.string().default(BRAVE_DEFAULTS.freshness).description("pd | pw | pm | py or a date range; empty = any time."),
	}).default({ ...BRAVE_DEFAULTS }),
	exa: z.object({
		type: z.union(["auto", "neural", "keyword", "fast"]).default(EXA_DEFAULTS.type),
		highlightsPerResult: z.number().step(1).min(1).max(10).default(EXA_DEFAULTS.highlightsPerResult),
		highlightSentences: z.number().step(1).min(1).max(10).default(EXA_DEFAULTS.highlightSentences),
		includeDomains: z.array(z.string()).default([]),
		excludeDomains: z.array(z.string()).default([]),
	}).default({ ...EXA_DEFAULTS, includeDomains: [], excludeDomains: [] }),
	serper: z.object({
		gl: z.string().default(SERPER_DEFAULTS.gl).description("Google country code, e.g. us, cn."),
		hl: z.string().default(SERPER_DEFAULTS.hl).description("Google UI language, e.g. en, zh-cn."),
	}).default({ ...SERPER_DEFAULTS }),
	jina: z.object({
		site: z.string().default(JINA_DEFAULTS.site).description("Restrict results to one domain (sent as `X-Site`)."),
	}).default({ ...JINA_DEFAULTS }),
	searxng: z.object({
		language: z.string().default(SEARXNG_DEFAULTS.language).description("Language code, e.g. en, zh-CN; empty = instance default."),
		categories: z.string().default(SEARXNG_DEFAULTS.categories).description("Comma-separated categories, e.g. general,news."),
		engines: z.string().default(SEARXNG_DEFAULTS.engines).description("Comma-separated engine names to restrict to."),
		safesearch: z.union([0, 1, 2]).default(SEARXNG_DEFAULTS.safesearch),
		timeRange: z.union(["", "day", "month", "year"]).default(SEARXNG_DEFAULTS.timeRange),
	}).default({ ...SEARXNG_DEFAULTS }),
});

/**
 * Options resolved once per search (see {@link HttpSearchProvider}).
 *
 * @typedef {object} ResolvedOptions
 * @property {import("./adapter.js").SearchAdapter} adapter
 * @property {string} [apiKey]                       Literal key; wins over `resolveApiKey`.
 * @property {() => Promise<string | undefined>} [resolveApiKey]
 * @property {() => boolean} [canResolveApiKey]      Cheap sync check for `available()`.
 * @property {string} apiKeyEnv
 * @property {string} baseURL
 * @property {number} timeoutMs
 * @property {number} maxResults
 * @property {Record<string, any>} [backend]         Backend-specific config section.
 * @property {(request: { endpoint: string, backend: string, query: string, maxResults: number }) => void} [recordRequest]
 */

/**
 * Search provider driven by a {@link import("./adapter.js").SearchAdapter}.
 * HTTP redirects fail as `WEB_PROVIDER_ERROR`; timeouts too (with a clear
 * message); caller aborts surface as `WEB_ABORTED`.
 */
export class HttpSearchProvider {
	/**
	 * @param {() => ResolvedOptions} resolveOptions thunk resolved once per call so
	 *   mid-flight settings changes never mix within one search.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
		this.id = resolveOptions().adapter.id;
	}

	available() {
		const options = this.resolveOptions();
		if (!URL.canParse(options.baseURL)) return false;
		// Key-less backends (self-hosted SearXNG) only need a parseable endpoint.
		if (options.adapter.requiresKey === false) return true;
		const hasKey = (options.apiKey?.length ?? 0) > 0
			|| (options.canResolveApiKey !== undefined ? options.canResolveApiKey() : options.resolveApiKey !== undefined);
		return hasKey;
	}

	/**
	 * @param {import("@deepseek-ai/dsh-web").WebSearchRequest} request
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<import("@deepseek-ai/dsh-web").WebSearchResult>}
	 */
	async search(request, signal) {
		const options = this.resolveOptions();
		const { adapter } = options;
		const label = adapter.id;
		await throwIfSearchAborted(signal, label);
		const apiKey = await this.apiKey(options, signal);
		await throwIfSearchAborted(signal, label);

		const maxResults = Math.min(Math.max(request.maxResults ?? options.maxResults ?? DEFAULT_MAX_RESULTS, 1), HARD_MAX_RESULTS);
		let built;
		try {
			built = adapter.buildRequest(request, {
				apiKey,
				baseURL: options.baseURL,
				maxResults,
				userAgent: USER_AGENT,
				backend: options.backend,
			});
		} catch (error) {
			throw await webError(`${label} search could not build the request: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
		try {
			options.recordRequest?.({ endpoint: built.url, backend: label, query: request.query, maxResults });
		} catch {
			// Session recording is best-effort; never fail a search over it.
		}
		await throwIfSearchAborted(signal, label);

		let response;
		try {
			response = await fetchWithTimeout(built.url, { redirect: "error", ...built.init }, { timeoutMs: options.timeoutMs, signal });
		} catch (error) {
			if (signal?.aborted === true || (isAbortError(error) && error?.name !== "TimeoutError")) throw await searchAborted(signal, label, error);
			if (error?.name === "TimeoutError") {
				throw await webError(`${label} search timed out after ${options.timeoutMs} ms (endpoint ${built.url}); raise "timeoutMs" in the web-search-${label} config or check connectivity`, "WEB_PROVIDER_ERROR", error);
			}
			throw await webError(`${label} search request failed: ${String(error?.cause?.message ?? error?.message ?? error)}`, "WEB_PROVIDER_ERROR", error);
		}

		if (!response.ok) {
			let json;
			try {
				json = await readJsonLoosely(response);
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw await searchAborted(signal, label, error);
			}
			throw await webError(adapter.describeError(response.status, json, { apiKeyEnv: options.apiKeyEnv }), "WEB_PROVIDER_ERROR");
		}

		let json;
		try {
			json = await response.json();
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw await searchAborted(signal, label, error);
			throw await webError(`${label} search returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
		try {
			return adapter.parseResponse(json, request, { maxResults });
		} catch (error) {
			if (error?.name === "WebError" && typeof error?.code === "string") throw error;
			throw await webError(`${label} search response could not be mapped: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
	}

	/** @param {ResolvedOptions} options @param {AbortSignal} [signal] */
	async apiKey(options, signal) {
		const label = options.adapter.id;
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw await searchAborted(signal, label, error);
			throw await webError(`${label} search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
		if (typeof resolved === "string" && resolved.length > 0) return resolved;
		// Optional credential: key-less backends proceed with an empty key.
		if (options.adapter.requiresKey === false) return "";
		throw await webError(
			`${label} search has no API key for "${options.apiKeyEnv}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-${label} settings/config`,
			"WEB_PROVIDER_CREDENTIAL_MISSING",
		);
	}
}

async function readJsonLoosely(response) {
	const text = await response.text();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text.slice(0, 300);
	}
}

async function throwIfSearchAborted(signal, label) {
	if (signal?.aborted === true) throw await searchAborted(signal, label);
}

/** Resolves to a `WebError("WEB_ABORTED")`; always `await` it. */
function searchAborted(signal, label, fallback) {
	return webError(`${label} search aborted`, "WEB_ABORTED", signal?.aborted === true ? signal.reason : fallback);
}

/**
 * Translate a (possibly hot-reloaded) config into per-search options.
 * @param {any} ctx
 * @param {any} config
 * @returns {ResolvedOptions}
 */
export function resolveOptions(ctx, config) {
	const adapter = getAdapter(config.backend ?? DEFAULT_BACKEND);
	const apiKeyEnv = nonEmpty(config.apiKeyEnv) ?? adapter.defaultApiKeyEnv;
	const resolver = apiKeyResolver(ctx, { apiKey: config.apiKey, apiKeyEnv });
	return {
		adapter,
		...(resolver.literal === undefined ? {} : { apiKey: resolver.literal }),
		resolveApiKey: () => resolver.resolve(),
		canResolveApiKey: () => resolver.canResolve(),
		apiKeyEnv,
		baseURL: nonEmpty(config.baseURL) ?? adapter.defaultBaseURL,
		timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
		maxResults: typeof config.maxResults === "number" ? config.maxResults : DEFAULT_MAX_RESULTS,
		backend: config[adapter.id] ?? {},
		recordRequest: (request) => {
			try {
				ctx.get("agents")?.currentInitiator()?.session.append("web/http-search-request", request);
			} catch {
				// best-effort
			}
		},
	};
}

function nonEmpty(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Register the HTTP search provider with `ctx.web`, hot-reloading from `~/.dsh/settings.yaml` (`web-search-<backend>:`). */
export function apply(ctx, config) {
	void bindHost(ctx); // make thrown errors genuine dsh-web WebError instances
	// Validate the backend eagerly so a typo fails at load time, not on first search.
	const adapter = getAdapter(config?.backend ?? DEFAULT_BACKEND);
	const current = liveConfig(ctx, `web-search-${adapter.id}`, Config, config);
	ctx.web.registerSearchProvider(new HttpSearchProvider(() => resolveOptions(ctx, { ...current(), backend: adapter.id })));
}
