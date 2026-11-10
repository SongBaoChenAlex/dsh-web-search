/**
 * Pure text / URL helpers. No I/O, no DSH imports — safe to unit test anywhere.
 * @module @tobedone4byme/dsh-web-shared/text
 */

/** Query parameters that only carry tracking state and never change page content. */
export const TRACKING_PARAMS = new Set([
	"fbclid", "gclid", "dclid", "msclkid", "yclid", "twclid", "igshid",
	"mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "ref_src", "spm", "_ga",
]);

/**
 * Truncate `text` to at most `max` characters, trying to cut at a word boundary
 * and appending `trailer` (counted inside the budget) when a cut happened.
 * @param {string | undefined} text
 * @param {number} max
 * @param {string} [trailer]
 * @returns {{ text: string | undefined, truncated: boolean }}
 */
export function truncate(text, max, trailer = "…") {
	if (text === undefined || text === null) return { text: undefined, truncated: false };
	const s = String(text);
	if (max <= 0 || s.length <= max) return { text: s, truncated: false };
	const budget = Math.max(max - trailer.length, 0);
	let cut = s.slice(0, budget);
	const lastSpace = cut.lastIndexOf(" ");
	// Only back off to a word boundary when it does not throw away too much.
	if (lastSpace > budget * 0.6) cut = cut.slice(0, lastSpace);
	return { text: cut.trimEnd() + trailer, truncated: true };
}

/**
 * Normalize a URL for comparison and strip tracking parameters.
 * Returns the input unchanged when it is not a parseable absolute URL.
 * @param {string} url
 * @param {{ stripTracking?: boolean }} [options]
 * @returns {string}
 */
export function cleanUrl(url, options = {}) {
	const stripTracking = options.stripTracking ?? true;
	let u;
	try {
		u = new URL(url);
	} catch {
		return url;
	}
	if (stripTracking) {
		const drop = [];
		for (const key of u.searchParams.keys()) {
			const k = key.toLowerCase();
			if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) drop.push(key);
		}
		for (const key of drop) u.searchParams.delete(key);
	}
	u.hash = "";
	u.hostname = u.hostname.toLowerCase();
	// Drop default ports and a lone trailing slash on the path for stable keys.
	if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
	let out = u.toString();
	if (u.pathname === "/" && u.search === "") out = out.replace(/\/$/u, "");
	return out;
}

/**
 * Keep the first occurrence of each key.
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string | undefined} keyOf  `undefined` keys are always kept.
 * @returns {T[]}
 */
export function dedupeBy(items, keyOf) {
	const seen = new Set();
	const out = [];
	for (const item of items) {
		const key = keyOf(item);
		if (key !== undefined) {
			if (seen.has(key)) continue;
			seen.add(key);
		}
		out.push(item);
	}
	return out;
}

/**
 * Collapse runs of whitespace and strip simple HTML highlight tags / entities
 * that search APIs leave in snippets.
 * @param {string | undefined} text
 * @returns {string | undefined}
 */
export function cleanSnippet(text) {
	if (typeof text !== "string") return undefined;
	const cleaned = text
		.replace(/<\/?(?:strong|b|em|i|mark)>/giu, "")
		.replace(/&amp;/gu, "&")
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&quot;/gu, '"')
		.replace(/&#x27;|&#39;/gu, "'")
		.replace(/&nbsp;/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

/** Rough token estimate (~4 chars/token for English, ~1.5 for CJK). Good enough for logs. */
export function estimateTokens(text) {
	if (!text) return 0;
	let cjk = 0;
	for (const ch of text) if (/[\u3000-\u9fff\uac00-\ud7af]/u.test(ch)) cjk++;
	return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}
