/**
 * SearXNG adapter — https://docs.searxng.org/dev/search_api.html
 *
 * GET `${baseURL}/search?q=…&format=json`. SearXNG is a self-hosted meta search
 * engine (class ④ in the README taxonomy): it aggregates many upstream engines
 * on your own server, so there is no API key and no per-query cost. The
 * instance must enable the JSON format (`search.formats: [html, json]` in
 * `settings.yml`). An optional bearer token is sent only when configured
 * (for instances behind an authenticating reverse proxy).
 *
 * `baseURL` must point at your instance; the default `http://127.0.0.1:8080`
 * matches the docker-compose quick start.
 *
 * @module @tobedone4byme/dsh-web-search-http/adapters/searxng
 */
import { cleanSnippet, dedupeBy } from "@tobedone4byme/dsh-web-shared/text";

export const SEARXNG_ID = "searxng";
export const SEARXNG_DEFAULT_BASE_URL = "http://127.0.0.1:8080";
export const SEARXNG_DEFAULT_API_KEY_ENV = "SEARXNG_API_KEY";
export const SEARXNG_MAX_RESULTS = 20;

export const SEARXNG_DEFAULTS = Object.freeze({
	language: "",
	categories: "",
	engines: "",
	safesearch: 1,
	timeRange: "",
});

function joinUrl(base, path) {
	return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** @type {import("../adapter.js").SearchAdapter} */
export const searxng = {
	id: SEARXNG_ID,
	defaultBaseURL: SEARXNG_DEFAULT_BASE_URL,
	defaultApiKeyEnv: SEARXNG_DEFAULT_API_KEY_ENV,
	requiresKey: false,
	meta: {
		label: "SearXNG (self-hosted)",
		kind: "self-hosted",
		docsUrl: "https://docs.searxng.org",
		keyUrl: "",
		freeTier: "free, self-hosted",
		description: "Aggregates many engines on your own server; no key, no per-query cost, privacy-preserving.",
	},

	buildRequest(request, options) {
		const cfg = { ...SEARXNG_DEFAULTS, ...(options.backend ?? {}) };
		const url = new URL(joinUrl(options.baseURL || SEARXNG_DEFAULT_BASE_URL, "/search"));
		url.searchParams.set("q", request.query);
		url.searchParams.set("format", "json");
		if (typeof cfg.language === "string" && cfg.language.length > 0) url.searchParams.set("language", cfg.language);
		if (typeof cfg.categories === "string" && cfg.categories.length > 0) url.searchParams.set("categories", cfg.categories);
		if (typeof cfg.engines === "string" && cfg.engines.length > 0) url.searchParams.set("engines", cfg.engines);
		if ([0, 1, 2].includes(cfg.safesearch)) url.searchParams.set("safesearch", String(cfg.safesearch));
		if (typeof cfg.timeRange === "string" && cfg.timeRange.length > 0) url.searchParams.set("time_range", cfg.timeRange);
		const headers = {
			"accept": "application/json",
			"accept-encoding": "gzip",
			"user-agent": options.userAgent,
		};
		if (typeof options.apiKey === "string" && options.apiKey.length > 0) headers.authorization = `Bearer ${options.apiKey}`;
		return {
			url: url.toString(),
			init: { method: "GET", redirect: "error", headers },
		};
	},

	parseResponse(json, _request, options) {
		const results = Array.isArray(json?.results) ? json.results : [];
		const limit = Math.min(Math.max(options?.maxResults ?? SEARXNG_MAX_RESULTS, 1), SEARXNG_MAX_RESULTS);
		const mapped = [];
		for (const item of results) {
			const url = typeof item?.url === "string" ? item.url.trim() : "";
			if (url.length === 0) continue;
			const title = cleanSnippet(item.title);
			const snippet = cleanSnippet(item.content);
			const publishedAt = typeof item.publishedDate === "string" && item.publishedDate.trim().length > 0
				? item.publishedDate.trim()
				: undefined;
			mapped.push({
				url,
				...(title !== undefined ? { title } : {}),
				...(snippet !== undefined ? { snippet } : {}),
				...(publishedAt !== undefined ? { publishedAt } : {}),
			});
		}
		const unique = dedupeBy(mapped, (s) => s.url);
		const sources = unique.slice(0, limit);
		const content = firstAnswer(json);
		return {
			...(content !== undefined ? { content } : {}),
			sources,
			truncated: unique.length > sources.length,
		};
	},

	describeError(status, json, options) {
		const env = options?.apiKeyEnv ?? SEARXNG_DEFAULT_API_KEY_ENV;
		let message;
		switch (status) {
			case 401:
			case 403:
				message = `SearXNG instance refused the request (HTTP ${status}); if it enforces JSON-format access or a proxy token, check the instance settings and the "${env}" credential`;
				break;
			case 429:
				message = "SearXNG instance rate limit reached (HTTP 429); check the limiter settings on the instance";
				break;
			case 404:
				message = "SearXNG endpoint not found (HTTP 404); check that \"baseURL\" points at the instance root";
				break;
			case 400:
			case 422:
				message = `SearXNG rejected the request (HTTP ${status})`;
				break;
			default:
				message = `SearXNG error (HTTP ${status})`;
		}
		const detail = typeof json === "string" ? json : (json?.message ?? json?.error ?? json?.detail);
		return typeof detail === "string" && detail.trim().length > 0 ? `${message}: ${detail.trim()}` : message;
	},
};

/** `answers[0]` (string or `{ answer }`) → `content`; `undefined` when the instance returned none. */
function firstAnswer(json) {
	const answers = Array.isArray(json?.answers) ? json.answers : [];
	for (const a of answers) {
		const text = cleanSnippet(typeof a === "string" ? a : a?.answer);
		if (text !== undefined) return text;
	}
	return undefined;
}
