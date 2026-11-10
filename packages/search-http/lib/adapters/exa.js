/**
 * Exa adapter — https://docs.exa.ai/reference/search
 *
 * POST `${baseURL}/search` with `x-api-key`. Exa is a neural / semantic search
 * engine (class ② in the README taxonomy): it finds pages *like* a description
 * rather than by keyword, and can return extracted text (`highlights`) per
 * result, which we map to `snippet`. Free tier: $10 credit on signup.
 *
 * @module @tobedone4byme/dsh-web-search-http/adapters/exa
 */
import { cleanSnippet, dedupeBy } from "@tobedone4byme/dsh-web-shared/text";

export const EXA_ID = "exa";
export const EXA_DEFAULT_BASE_URL = "https://api.exa.ai";
export const EXA_DEFAULT_API_KEY_ENV = "EXA_API_KEY";
export const EXA_MAX_RESULTS = 100;

export const EXA_DEFAULTS = Object.freeze({
	type: "auto",
	highlightsPerResult: 2,
	highlightSentences: 3,
	includeDomains: [],
	excludeDomains: [],
});

function stringList(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function joinUrl(base, path) {
	return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** @type {import("../adapter.js").SearchAdapter} */
export const exa = {
	id: EXA_ID,
	defaultBaseURL: EXA_DEFAULT_BASE_URL,
	defaultApiKeyEnv: EXA_DEFAULT_API_KEY_ENV,
	meta: {
		label: "Exa",
		kind: "llm-native",
		docsUrl: "https://docs.exa.ai/",
		keyUrl: "https://dashboard.exa.ai/api-keys",
		freeTier: "$10 starter credit",
		description: "Neural search: finds pages by meaning, returns extracted highlights.",
	},

	buildRequest(request, options) {
		const cfg = { ...EXA_DEFAULTS, ...(options.backend ?? {}) };
		const numResults = Math.min(Math.max(Math.trunc(options.maxResults) || 1, 1), EXA_MAX_RESULTS);
		const body = {
			query: request.query,
			type: ["auto", "neural", "keyword", "fast"].includes(cfg.type) ? cfg.type : "auto",
			numResults,
			contents: {
				highlights: {
					numSentences: Math.max(1, Math.trunc(cfg.highlightSentences) || 3),
					highlightsPerUrl: Math.max(1, Math.trunc(cfg.highlightsPerResult) || 2),
				},
			},
		};
		const includeDomains = stringList(cfg.includeDomains);
		const excludeDomains = stringList(cfg.excludeDomains);
		if (includeDomains.length > 0) body.includeDomains = includeDomains;
		if (excludeDomains.length > 0) body.excludeDomains = excludeDomains;
		return {
			url: joinUrl(options.baseURL || EXA_DEFAULT_BASE_URL, "/search"),
			init: {
				method: "POST",
				redirect: "error",
				headers: {
					"x-api-key": options.apiKey,
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
		const limit = Math.min(Math.max(options?.maxResults ?? EXA_MAX_RESULTS, 1), EXA_MAX_RESULTS);
		const mapped = [];
		for (const item of results) {
			const url = typeof item?.url === "string" ? item.url.trim() : "";
			if (url.length === 0) continue;
			const title = cleanSnippet(item.title);
			const highlights = Array.isArray(item.highlights) ? item.highlights.filter((h) => typeof h === "string") : [];
			const snippet = cleanSnippet(highlights.join(" … ")) ?? cleanSnippet(item.text);
			const publishedAt = typeof item.publishedDate === "string" && item.publishedDate.length > 0 ? item.publishedDate : undefined;
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
		const env = options?.apiKeyEnv ?? EXA_DEFAULT_API_KEY_ENV;
		let message;
		switch (status) {
			case 401:
			case 403:
				message = `Exa rejected the API key (HTTP ${status}); check the "${env}" credential`;
				break;
			case 429:
				message = "Exa rate limit reached (HTTP 429)";
				break;
			case 402:
				message = "Exa credit exhausted (HTTP 402); top up the account";
				break;
			case 400:
			case 422:
				message = `Exa rejected the request (HTTP ${status})`;
				break;
			default:
				message = `Exa API error (HTTP ${status})`;
		}
		const detail = json?.error ?? json?.message ?? json?.detail;
		return typeof detail === "string" && detail.length > 0 ? `${message}: ${detail}` : message;
	},
};
