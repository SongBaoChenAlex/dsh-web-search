/**
 * `tavily-extract` — a `web_fetch` provider for the DeepSeek Harness web seam
 * backed by Tavily's `/extract` endpoint.
 *
 * Compared with `readability-http` (`@tobedone4byme/dsh-web-fetch-readability`):
 * - Tavily renders JavaScript-heavy pages, reads PDFs and gets past many
 *   anti-bot front doors that a plain HTTP GET cannot.
 * - It **sends the URL to a third party** (Tavily) and **costs credits**
 *   (1 credit per 5 URLs at `basic` depth, 2 per 5 at `advanced`), so it is
 *   registered but *not* selected by default.
 * - No SSRF guard is needed: the request leaves this machine only toward
 *   `api.tavily.com`, and Tavily cannot reach private networks. Non-http(s)
 *   schemes are still rejected up front so the model gets a clear message.
 *
 * Output is `kind: 'text'` (Tavily already returns Markdown), capped at
 * `maxOutputChars` with a `[truncated: shown N of M chars]` trailer. A URL that
 * Tavily reports in `failed_results` becomes a `statusCode: 502` *result*,
 * not a thrown error, so the model can reason about it.
 *
 * @module @tobedone4byme/dsh-web-tavily-tools/extract
 */
import { webError } from "@tobedone4byme/dsh-web-shared/http";

/** Stable id this provider registers under (select it via the `web` row's `fetchProvider`). */
export const TAVILY_EXTRACT_PROVIDER_ID = "tavily-extract";

export const EXTRACT_DEFAULTS = Object.freeze({
	depth: "basic",
	maxOutputChars: 20_000,
});

/**
 * Cap text with a visible trailer.
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function capText(text, maxChars) {
	const total = text.length;
	if (!Number.isFinite(maxChars) || maxChars <= 0 || total <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, maxChars)}\n[truncated: shown ${maxChars} of ${total} chars]`, truncated: true };
}

/**
 * Validate the scheme without touching the network.
 * @param {string} raw
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function checkUrl(raw) {
	const trimmed = String(raw ?? "").trim();
	if (trimmed.length === 0) return { ok: false, reason: "URL is empty" };
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, reason: "URL is not absolute or not parseable" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: `scheme "${parsed.protocol.replace(/:$/u, "")}" is not supported; only http and https are` };
	}
	return { ok: true, url: trimmed };
}

/** Normalize for matching Tavily's echoed URL against ours (trailing slash / case of host). */
function urlKey(u) {
	try {
		const p = new URL(u);
		p.hash = "";
		return p.href.replace(/\/+$/u, "");
	} catch {
		return String(u).trim().replace(/\/+$/u, "");
	}
}

/**
 * @implements {import('@deepseek-ai/dsh-web').WebFetchProvider}
 */
export class TavilyExtractFetchProvider {
	id = TAVILY_EXTRACT_PROVIDER_ID;

	/**
	 * @param {ReturnType<import('./tavily-client.js').createTavilyClient>} client
	 * @param {() => { depth?: 'basic' | 'advanced', maxOutputChars?: number }} [resolveOptions]
	 *   thunk resolved once per fetch so live settings changes never mix mid-flight.
	 */
	constructor(client, resolveOptions = () => ({})) {
		this.client = client;
		this.resolveOptions = resolveOptions;
	}

	/** True when an API key is plausibly resolvable. */
	available() {
		try {
			return this.client.available();
		} catch {
			return false;
		}
	}

	/**
	 * @param {{ url: string }} request
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<import('@deepseek-ai/dsh-web').WebFetchResult>}
	 */
	async fetch(request, signal) {
		const opts = { ...EXTRACT_DEFAULTS, ...stripUndefined(this.resolveOptions()) };
		const check = checkUrl(request?.url);
		if (!check.ok) {
			throw await webError(`tavily-extract refused ${JSON.stringify(String(request?.url ?? ""))}: ${check.reason}`, "WEB_PROVIDER_ERROR");
		}
		const url = check.url;
		if (signal?.aborted === true) {
			throw await webError("web_fetch aborted", "WEB_ABORTED", signal.reason);
		}

		const response = await this.client.extract([url], { extractDepth: opts.depth, format: "markdown" }, signal);

		const want = urlKey(url);
		const hit = response.results.find((r) => urlKey(r.url) === want) ?? response.results[0];
		if (hit !== undefined) {
			const capped = capText(hit.rawContent ?? "", opts.maxOutputChars);
			return { url: hit.url || url, statusCode: 200, body: { kind: "text", content: capped.text }, truncated: capped.truncated };
		}

		const failed = response.failedResults.find((r) => urlKey(r.url) === want) ?? response.failedResults[0];
		const reason = failed?.error ?? "no content returned";
		return {
			url,
			statusCode: 502,
			body: { kind: "text", content: `Tavily could not extract ${url}: ${reason}` },
			truncated: false,
		};
	}
}

function stripUndefined(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v;
	return out;
}
