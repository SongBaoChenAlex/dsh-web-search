/**
 * Jina Search adapter — https://jina.ai/reader (the `s.jina.ai` endpoint)
 *
 * GET `${baseURL}/?q=…` with `Authorization: Bearer <key>` and
 * `Accept: application/json`. Jina is an LLM-oriented reader-style search
 * (class ② in the README taxonomy): by default it returns the *full* cleaned
 * page text per result, which would blow the context budget, so we send
 * `X-Respond-With: no-content` and map `description` (falling back to the first
 * 300 chars of any `content`) to `snippet`. Free tier: 10M tokens.
 *
 * @module @baoson/dsh-web-search-http/adapters/jina
 */
import { cleanSnippet, dedupeBy } from "@baoson/dsh-web-shared/text";

export const JINA_ID = "jina";
export const JINA_DEFAULT_BASE_URL = "https://s.jina.ai";
export const JINA_DEFAULT_API_KEY_ENV = "JINA_API_KEY";
export const JINA_MAX_RESULTS = 20;
/** Snippet fallback length when a result carries `content` but no `description`. */
export const JINA_CONTENT_SNIPPET_CHARS = 300;

export const JINA_DEFAULTS = Object.freeze({
	site: "",
});

/** @type {import("../adapter.js").SearchAdapter} */
export const jina = {
	id: JINA_ID,
	defaultBaseURL: JINA_DEFAULT_BASE_URL,
	defaultApiKeyEnv: JINA_DEFAULT_API_KEY_ENV,
	meta: {
		label: "Jina Search",
		kind: "llm-native",
		docsUrl: "https://jina.ai/reader",
		keyUrl: "https://jina.ai/api-dashboard",
		freeTier: "10M tokens free",
		description: "Reader-style search returning cleaned page summaries; good for LLM consumption.",
	},

	buildRequest(request, options) {
		const cfg = { ...JINA_DEFAULTS, ...(options.backend ?? {}) };
		const base = (options.baseURL || JINA_DEFAULT_BASE_URL).replace(/\/+$/u, "");
		const url = new URL(`${base}/`);
		url.searchParams.set("q", request.query);
		const headers = {
			"authorization": `Bearer ${options.apiKey}`,
			"accept": "application/json",
			"accept-encoding": "gzip",
			"user-agent": options.userAgent,
			// Snippets only — full pages are web_fetch's job.
			"x-respond-with": "no-content",
		};
		if (typeof cfg.site === "string" && cfg.site.length > 0) headers["x-site"] = cfg.site;
		return {
			url: url.toString(),
			init: { method: "GET", redirect: "error", headers },
		};
	},

	parseResponse(json, _request, options) {
		const results = Array.isArray(json?.data) ? json.data : [];
		const limit = Math.min(Math.max(options?.maxResults ?? JINA_MAX_RESULTS, 1), JINA_MAX_RESULTS);
		const mapped = [];
		for (const item of results) {
			const url = typeof item?.url === "string" ? item.url.trim() : "";
			if (url.length === 0) continue;
			const title = cleanSnippet(item.title);
			const snippet = cleanSnippet(item.description)
				?? cleanSnippet(typeof item.content === "string" ? item.content.slice(0, JINA_CONTENT_SNIPPET_CHARS) : undefined);
			const publishedAt = typeof item.date === "string" && item.date.trim().length > 0 ? item.date.trim() : undefined;
			mapped.push({
				url,
				...(title !== undefined ? { title } : {}),
				...(snippet !== undefined ? { snippet } : {}),
				...(publishedAt !== undefined ? { publishedAt } : {}),
			});
		}
		const unique = dedupeBy(mapped, (s) => s.url);
		const sources = unique.slice(0, limit);
		return { sources, truncated: unique.length > sources.length };
	},

	describeError(status, json, options) {
		const env = options?.apiKeyEnv ?? JINA_DEFAULT_API_KEY_ENV;
		let message;
		switch (status) {
			case 401:
			case 403:
				message = `Jina rejected the API key (HTTP ${status}); check the "${env}" credential`;
				break;
			case 429:
				message = "Jina rate limit reached (HTTP 429)";
				break;
			case 402:
				message = "Jina token balance exhausted (HTTP 402); top up the account";
				break;
			case 400:
			case 422:
				message = `Jina rejected the request (HTTP ${status})`;
				break;
			default:
				message = `Jina Search API error (HTTP ${status})`;
		}
		const detail = typeof json === "string" ? json : (json?.message ?? json?.readableMessage ?? json?.error ?? json?.detail);
		return typeof detail === "string" && detail.trim().length > 0 ? `${message}: ${detail.trim()}` : message;
	},
};
