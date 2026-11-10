/**
 * Serper adapter — https://serper.dev/docs
 *
 * POST `${baseURL}/search` with `X-API-KEY`. Serper is a thin, cheap wrapper
 * around Google SERPs (class ① in the README taxonomy): `organic[]` carries a
 * short `snippet` only, so the model will usually follow up with `web_fetch`.
 * When Google shows an answer box we surface its text as the result `content`.
 * Free tier: 2,500 queries one-time; the free plan caps `num` at 10.
 *
 * @module @tobedone4byme/dsh-web-search-http/adapters/serper
 */
import { cleanSnippet, dedupeBy } from "@tobedone4byme/dsh-web-shared/text";

export const SERPER_ID = "serper";
export const SERPER_DEFAULT_BASE_URL = "https://google.serper.dev";
export const SERPER_DEFAULT_API_KEY_ENV = "SERPER_API_KEY";
/** Free-plan ceiling for `num`; higher values are a paid-plan feature. */
export const SERPER_MAX_RESULTS = 10;

export const SERPER_DEFAULTS = Object.freeze({
	gl: "",
	hl: "",
});

function joinUrl(base, path) {
	return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** @type {import("../adapter.js").SearchAdapter} */
export const serper = {
	id: SERPER_ID,
	defaultBaseURL: SERPER_DEFAULT_BASE_URL,
	defaultApiKeyEnv: SERPER_DEFAULT_API_KEY_ENV,
	meta: {
		label: "Serper",
		kind: "engine",
		docsUrl: "https://serper.dev/docs",
		keyUrl: "https://serper.dev/api-key",
		freeTier: "2,500 queries one-time",
		description: "Google results via a cheap SERP API; snippet-only.",
	},

	buildRequest(request, options) {
		const cfg = { ...SERPER_DEFAULTS, ...(options.backend ?? {}) };
		const num = Math.min(Math.max(Math.trunc(options.maxResults) || 1, 1), SERPER_MAX_RESULTS);
		const body = { q: request.query, num };
		if (typeof cfg.gl === "string" && cfg.gl.length > 0) body.gl = cfg.gl;
		if (typeof cfg.hl === "string" && cfg.hl.length > 0) body.hl = cfg.hl;
		return {
			url: joinUrl(options.baseURL || SERPER_DEFAULT_BASE_URL, "/search"),
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
		const results = Array.isArray(json?.organic) ? json.organic : [];
		const limit = Math.min(Math.max(options?.maxResults ?? SERPER_MAX_RESULTS, 1), SERPER_MAX_RESULTS);
		const mapped = [];
		for (const item of results) {
			const url = typeof item?.link === "string" ? item.link.trim() : "";
			if (url.length === 0) continue;
			const title = cleanSnippet(item.title);
			const snippet = cleanSnippet(item.snippet);
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
		const content = answerBoxText(json?.answerBox);
		return {
			...(content !== undefined ? { content } : {}),
			sources,
			truncated: unique.length > sources.length,
		};
	},

	describeError(status, json, options) {
		const env = options?.apiKeyEnv ?? SERPER_DEFAULT_API_KEY_ENV;
		let message;
		switch (status) {
			case 401:
			case 403:
				message = `Serper rejected the API key (HTTP ${status}); check the "${env}" credential`;
				break;
			case 429:
				message = "Serper rate limit reached (HTTP 429)";
				break;
			case 402:
				message = "Serper credit exhausted (HTTP 402); top up the account";
				break;
			case 400:
			case 422:
				message = `Serper rejected the request (HTTP ${status})`;
				break;
			default:
				message = `Serper API error (HTTP ${status})`;
		}
		const detail = typeof json === "string" ? json : (json?.message ?? json?.error ?? json?.detail);
		return typeof detail === "string" && detail.trim().length > 0 ? `${message}: ${detail.trim()}` : message;
	},
};

/** One short paragraph from Google's answer box (`answer` wins over `snippet`); `undefined` when absent. */
function answerBoxText(box) {
	if (box === undefined || box === null || typeof box !== "object") return undefined;
	const text = cleanSnippet(box.answer) ?? cleanSnippet(box.snippet);
	if (text === undefined) return undefined;
	const title = cleanSnippet(box.title);
	return title !== undefined && title !== text ? `${title}: ${text}` : text;
}
