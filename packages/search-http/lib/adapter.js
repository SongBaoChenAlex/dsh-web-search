/**
 * Backend adapter contract for `@tobedone4byme/dsh-web-search-http`.
 *
 * An adapter is a pure, stateless description of one search API: how to build
 * the HTTP request, how to map its JSON into the `dsh-web` result vocabulary,
 * and how to turn an error status into a human-readable message. Everything
 * else — credential resolution, timeouts, abort handling, `WebError` mapping,
 * settings hot-reload — lives in `index.js` and is shared by every backend.
 *
 * Adding a backend = one new file under `adapters/` + one entry in {@link adapters}.
 *
 * @module @tobedone4byme/dsh-web-search-http/adapter
 */
import { tavily } from "./adapters/tavily.js";
import { brave } from "./adapters/brave.js";
import { exa } from "./adapters/exa.js";
import { serper } from "./adapters/serper.js";
import { jina } from "./adapters/jina.js";
import { searxng } from "./adapters/searxng.js";

/**
 * @typedef {import("@deepseek-ai/dsh-web").WebSearchRequest} WebSearchRequest
 * @typedef {import("@deepseek-ai/dsh-web").WebSearchResult} WebSearchResult
 */

/**
 * Options handed to {@link SearchAdapter.buildRequest}. The plugin resolves
 * these from its config once per search.
 *
 * @typedef {object} AdapterRequestOptions
 * @property {string} apiKey        Resolved API key (never empty unless the adapter sets `requiresKey: false`).
 * @property {string} baseURL       Endpoint base (trailing slashes tolerated).
 * @property {number} maxResults    Upper bound for this search (already clamped by the plugin).
 * @property {string} userAgent     Value for the `user-agent` header.
 * @property {Record<string, any>} [backend]  Backend-specific config section (e.g. `config.tavily`).
 */

/**
 * @typedef {object} SearchAdapter
 * @property {string} id                 Backend id; also the provider id registered with `ctx.web`.
 * @property {string} defaultBaseURL     Used when the config leaves `baseURL` empty.
 * @property {string} defaultApiKeyEnv   Used when the config leaves `apiKeyEnv` empty.
 * @property {(request: WebSearchRequest, options: AdapterRequestOptions) => { url: string, init: RequestInit }} buildRequest
 *   Build the outgoing request. Must not include `signal`; the plugin merges timeout + abort.
 * @property {(json: any, request: WebSearchRequest, options: { maxResults: number }) => WebSearchResult} parseResponse
 *   Map a 2xx JSON body to the seam's normalized shape.
 * @property {(status: number, json: any, options: { apiKeyEnv: string }) => string} describeError
 *   Human-readable message for a non-2xx response (`json` may be `undefined`).
 * @property {AdapterMeta} [meta]  Display metadata for selector UIs.
 * @property {boolean} [requiresKey]  `false` for key-less backends (self-hosted SearXNG): the
 *   provider is available without a credential and `apiKey` may be empty in `buildRequest`.
 */

/**
 * @typedef {object} AdapterMeta
 * @property {string} label        Human name ("Tavily").
 * @property {'engine' | 'llm-native' | 'model-embedded' | 'self-hosted'} kind  README taxonomy class.
 * @property {string} docsUrl
 * @property {string} keyUrl       Where to obtain an API key.
 * @property {string} freeTier     One-line free-tier summary.
 * @property {string} description  One sentence.
 */

/** Registry of built-in adapters keyed by backend id. */
export const adapters = Object.freeze({
	[tavily.id]: tavily,
	[brave.id]: brave,
	[exa.id]: exa,
	[serper.id]: serper,
	[jina.id]: jina,
	[searxng.id]: searxng,
});

/** Display catalog for selector UIs: every known backend with its metadata. */
export function catalog() {
	return Object.values(adapters).map((a) => ({
		id: a.id,
		defaultApiKeyEnv: a.defaultApiKeyEnv,
		defaultBaseURL: a.defaultBaseURL,
		requiresKey: a.requiresKey !== false,
		...(a.meta ?? { label: a.id, kind: "engine", docsUrl: "", keyUrl: "", freeTier: "", description: "" }),
	}));
}

/**
 * Look up an adapter by backend id.
 * @param {string} id
 * @returns {SearchAdapter}
 */
export function getAdapter(id) {
	const adapter = typeof id === "string" ? adapters[id] : undefined;
	if (adapter === undefined) {
		const known = Object.keys(adapters).map((k) => `"${k}"`).join(", ");
		throw new Error(`web-search-http: unknown backend "${String(id)}"; known backends: ${known}. Add a file under lib/adapters/ and register it in lib/adapter.js to support another API.`);
	}
	return adapter;
}

export { tavily, brave, exa, serper, jina, searxng };
