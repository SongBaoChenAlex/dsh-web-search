/**
 * Tavily adapter — https://docs.tavily.com/documentation/api-reference/endpoint/search
 *
 * POST `${baseURL}/search` with `Authorization: Bearer <key>`. Tavily is an
 * LLM-native search API: besides title/url it returns an extracted `content`
 * passage per result and (optionally) a synthesized `answer`. We map
 * `answer → content`, `results[].content → snippet`, `published_date → publishedAt`.
 * Relevance `score` and `raw_content` are dropped (`raw_content` is `web_fetch`'s job).
 *
 * @module @tobedone4byme/dsh-web-search-http/adapters/tavily
 */
import { cleanSnippet, dedupeBy } from "@tobedone4byme/dsh-web-shared/text";

export const TAVILY_ID = "tavily";
export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
export const TAVILY_DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
/** Tavily's documented hard ceiling for `max_results`. */
export const TAVILY_MAX_RESULTS = 20;

/** Defaults for the `tavily:` config section; `index.js` mirrors them in its schema. */
export const TAVILY_DEFAULTS = Object.freeze({
	searchDepth: "basic",
	includeAnswer: true,
	includeRawContent: false,
	topic: "general",
	includeDomains: [],
	excludeDomains: [],
});

function stringList(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

/**
 * @param {string} base
 * @param {string} path
 */
function joinUrl(base, path) {
	return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** @type {import("../adapter.js").SearchAdapter} */
export const tavily = {
	id: TAVILY_ID,
	defaultBaseURL: TAVILY_DEFAULT_BASE_URL,
	defaultApiKeyEnv: TAVILY_DEFAULT_API_KEY_ENV,
	meta: {
		label: "Tavily",
		kind: "llm-native",
		docsUrl: "https://docs.tavily.com/",
		keyUrl: "https://app.tavily.com/home",
		freeTier: "1,000 credits/month",
		description: "LLM-native search: extracted passages per result plus an optional synthesized answer.",
	},

	buildRequest(request, options) {
		const cfg = { ...TAVILY_DEFAULTS, ...(options.backend ?? {}) };
		const maxResults = Math.min(Math.max(Math.trunc(options.maxResults) || 1, 1), TAVILY_MAX_RESULTS);
		const body = {
			query: request.query,
			search_depth: cfg.searchDepth === "advanced" ? "advanced" : "basic",
			max_results: maxResults,
			include_answer: cfg.includeAnswer !== false,
			// Full pages are web_fetch's responsibility; keep the search payload small.
			include_raw_content: cfg.includeRawContent === true,
			topic: cfg.topic === "news" ? "news" : "general",
		};
		const includeDomains = stringList(cfg.includeDomains);
		const excludeDomains = stringList(cfg.excludeDomains);
		if (includeDomains.length > 0) body.include_domains = includeDomains;
		if (excludeDomains.length > 0) body.exclude_domains = excludeDomains;
		return {
			url: joinUrl(options.baseURL || TAVILY_DEFAULT_BASE_URL, "/search"),
			init: {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${options.apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"accept-encoding": "gzip",
					"user-agent": options.userAgent,
				},
				body: JSON.stringify(body),
			},
		};
	},

	parseResponse(json, _request, options) {
		const results = Array.isArray(json?.results) ? json.results : [];
		const limit = Math.min(Math.max(options?.maxResults ?? TAVILY_MAX_RESULTS, 1), TAVILY_MAX_RESULTS);
		const mapped = [];
		for (const item of results) {
			const url = typeof item?.url === "string" ? item.url.trim() : "";
			if (url.length === 0) continue;
			const title = cleanSnippet(item.title);
			const snippet = cleanSnippet(item.content);
			const publishedAt = typeof item.published_date === "string" && item.published_date.trim().length > 0
				? item.published_date.trim()
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
		const answer = typeof json?.answer === "string" ? json.answer.trim() : "";
		return {
			...(answer.length > 0 ? { content: answer } : {}),
			sources,
			truncated: unique.length > sources.length,
		};
	},

	describeError(status, json, options) {
		const env = options?.apiKeyEnv ?? TAVILY_DEFAULT_API_KEY_ENV;
		let message;
		switch (status) {
			case 401:
			case 403:
				message = `Tavily rejected the API key (HTTP ${status}); check the "${env}" credential`;
				break;
			case 429:
				message = "Tavily rate limit reached (HTTP 429); slow down or upgrade the plan";
				break;
			case 432:
				message = "Tavily plan usage limit exceeded (HTTP 432); the monthly credit quota is exhausted";
				break;
			case 400:
			case 422:
				message = `Tavily rejected the request (HTTP ${status})`;
				break;
			default:
				message = `Tavily API error (HTTP ${status})`;
		}
		const detail = extractDetail(json);
		return detail !== undefined ? `${message}: ${detail}` : message;
	},
};

/** Tavily error bodies are `{ detail: { error } }`, `{ detail }`, `{ error }` or `{ message }`. */
function extractDetail(json) {
	if (json === undefined || json === null) return undefined;
	if (typeof json === "string") return json.trim() || undefined;
	const candidates = [json.detail?.error, json.detail, json.error, json.message];
	for (const c of candidates) {
		if (typeof c === "string" && c.trim().length > 0) return c.trim();
	}
	return undefined;
}
