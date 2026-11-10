/**
 * Brave Search API adapter — https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
 *
 * GET `${baseURL}/web/search?q=…&count=…` with `X-Subscription-Token`. A
 * classic search-engine API (class ① in the README taxonomy): results carry a
 * short `description` snippet only, so the model will usually follow up with
 * `web_fetch`. Free tier: 2 000 queries/month, 1 request/second.
 *
 * @module @tobedone4byme/dsh-web-search-http/adapters/brave
 */
import { cleanSnippet, dedupeBy } from "@tobedone4byme/dsh-web-shared/text";

export const BRAVE_ID = "brave";
export const BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1";
export const BRAVE_DEFAULT_API_KEY_ENV = "BRAVE_SEARCH_API_KEY";
export const BRAVE_MAX_RESULTS = 20;

export const BRAVE_DEFAULTS = Object.freeze({
	country: "",
	searchLang: "",
	safesearch: "moderate",
	freshness: "",
});

function joinUrl(base, path) {
	return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** @type {import("../adapter.js").SearchAdapter} */
export const brave = {
	id: BRAVE_ID,
	defaultBaseURL: BRAVE_DEFAULT_BASE_URL,
	defaultApiKeyEnv: BRAVE_DEFAULT_API_KEY_ENV,
	meta: {
		label: "Brave Search",
		kind: "engine",
		docsUrl: "https://brave.com/search/api/",
		keyUrl: "https://api-dashboard.search.brave.com/app/keys",
		freeTier: "2,000 queries/month",
		description: "Independent search index; fast and cheap, snippet-only results.",
	},

	buildRequest(request, options) {
		const cfg = { ...BRAVE_DEFAULTS, ...(options.backend ?? {}) };
		const count = Math.min(Math.max(Math.trunc(options.maxResults) || 1, 1), BRAVE_MAX_RESULTS);
		const url = new URL(joinUrl(options.baseURL || BRAVE_DEFAULT_BASE_URL, "/web/search"));
		url.searchParams.set("q", request.query);
		url.searchParams.set("count", String(count));
		if (cfg.country) url.searchParams.set("country", cfg.country);
		if (cfg.searchLang) url.searchParams.set("search_lang", cfg.searchLang);
		if (cfg.safesearch) url.searchParams.set("safesearch", cfg.safesearch);
		if (cfg.freshness) url.searchParams.set("freshness", cfg.freshness);
		return {
			url: url.toString(),
			init: {
				method: "GET",
				redirect: "error",
				headers: {
					"x-subscription-token": options.apiKey,
					"accept": "application/json",
					"accept-encoding": "gzip",
					"user-agent": options.userAgent,
				},
			},
		};
	},

	parseResponse(json, _request, options) {
		const results = Array.isArray(json?.web?.results) ? json.web.results : [];
		const limit = Math.min(Math.max(options?.maxResults ?? BRAVE_MAX_RESULTS, 1), BRAVE_MAX_RESULTS);
		const mapped = [];
		for (const item of results) {
			const url = typeof item?.url === "string" ? item.url.trim() : "";
			if (url.length === 0) continue;
			const title = cleanSnippet(item.title);
			const snippet = cleanSnippet(item.description);
			const publishedAt = typeof item.page_age === "string" && item.page_age.length > 0 ? item.page_age : undefined;
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
		const env = options?.apiKeyEnv ?? BRAVE_DEFAULT_API_KEY_ENV;
		let message;
		switch (status) {
			case 401:
			case 403:
				message = `Brave Search rejected the API key (HTTP ${status}); check the "${env}" credential`;
				break;
			case 429:
				message = "Brave Search rate limit reached (HTTP 429; free plan: 1 request/second, 2,000/month)";
				break;
			case 422:
				message = "Brave Search rejected the request parameters (HTTP 422)";
				break;
			default:
				message = `Brave Search API error (HTTP ${status})`;
		}
		const detail = json?.error?.detail ?? json?.error?.meta?.errors?.[0]?.msg ?? json?.message;
		return typeof detail === "string" && detail.length > 0 ? `${message}: ${detail}` : message;
	},
};
