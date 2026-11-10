/**
 * Pure shaping of a `web_search` tool value. No I/O, no DSH imports.
 *
 * Input shape (from `@deepseek-ai/dsh-tool-web`):
 * `{ content?: string, sources: [{ url, title?, snippet?, publishedAt? }], truncated: boolean }`
 *
 * @module @baoson/dsh-web-search-governor/shape
 */
import { cleanSnippet, cleanUrl, estimateTokens, truncate } from "@baoson/dsh-web-shared/text";

/**
 * @typedef {object} ShapeCaps
 * @property {number} maxSources        keep at most this many sources after dedupe (0 = unlimited)
 * @property {number} snippetMaxChars   per-source snippet cap (0 = unlimited)
 * @property {number} contentMaxChars   cap for the provider's synthesized answer (0 = unlimited)
 * @property {boolean} stripTrackingParams  remove utm_* / fbclid / … from URLs
 */

/** @type {ShapeCaps} */
export const DEFAULT_CAPS = Object.freeze({
	maxSources: 5,
	snippetMaxChars: 300,
	contentMaxChars: 1500,
	stripTrackingParams: true,
});

/**
 * Merge base caps with an optional per-provider override. Only own, defined
 * keys of the override win; everything else falls back to `base`, then to
 * `DEFAULT_CAPS`.
 * @param {Partial<ShapeCaps>} base
 * @param {Record<string, Partial<ShapeCaps> | undefined> | undefined} overrides
 * @param {string | undefined} providerId
 * @returns {ShapeCaps}
 */
export function resolveCaps(base, overrides, providerId) {
	const override = providerId !== undefined && overrides ? overrides[providerId] : undefined;
	/** @type {any} */
	const out = { ...DEFAULT_CAPS };
	for (const layer of [base, override]) {
		if (!layer || typeof layer !== "object") continue;
		for (const key of Object.keys(DEFAULT_CAPS)) {
			if (Object.hasOwn(layer, key) && layer[key] !== undefined && layer[key] !== null) out[key] = layer[key];
		}
	}
	return out;
}

/** Characters in a value as the model will roughly see it (JSON is a fair proxy). */
function charCount(value) {
	try {
		return JSON.stringify(value).length;
	} catch {
		return 0;
	}
}

/**
 * Shape a `web_search` value: dedupe sources by cleaned URL, rewrite URLs to
 * their cleaned form, clean + cap snippets, cap the answer, cap the source
 * count. Never adds information; never throws on odd input (returns it as-is).
 *
 * @param {any} value
 * @param {Partial<ShapeCaps>} [caps]
 * @returns {{ value: any, stats: { charsBefore: number, charsAfter: number, tokensBefore: number, tokensAfter: number, sourcesBefore: number, sourcesAfter: number } }}
 */
export function shapeSearchValue(value, caps = {}) {
	const c = resolveCaps(caps, undefined, undefined);
	if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(value.sources)) {
		const chars = charCount(value);
		const tokens = estimateTokens(typeof value === "string" ? value : JSON.stringify(value ?? ""));
		return { value, stats: { charsBefore: chars, charsAfter: chars, tokensBefore: tokens, tokensAfter: tokens, sourcesBefore: 0, sourcesAfter: 0 } };
	}

	const before = JSON.stringify(value);
	const sourcesBefore = value.sources.length;

	const seen = new Set();
	/** @type {any[]} */
	const sources = [];
	for (const raw of value.sources) {
		if (typeof raw !== "object" || raw === null || typeof raw.url !== "string") continue;
		const url = cleanUrl(raw.url, { stripTracking: c.stripTrackingParams });
		const key = cleanUrl(raw.url, { stripTracking: true }); // dedupe key always ignores tracking params
		if (seen.has(key)) continue;
		seen.add(key);
		/** @type {any} */
		const source = { url };
		if (typeof raw.title === "string") {
			const title = cleanSnippet(raw.title);
			if (title !== undefined) source.title = title;
		}
		if (typeof raw.snippet === "string") {
			const snippet = truncate(cleanSnippet(raw.snippet), c.snippetMaxChars).text;
			if (snippet !== undefined && snippet.length > 0) source.snippet = snippet;
		}
		if (typeof raw.publishedAt === "string" && raw.publishedAt.length > 0) source.publishedAt = raw.publishedAt;
		sources.push(source);
	}

	let truncated = value.truncated === true;
	if (c.maxSources > 0 && sources.length > c.maxSources) {
		sources.length = c.maxSources;
		truncated = true;
	}

	/** @type {any} */
	const shaped = {};
	if (typeof value.content === "string" && value.content.length > 0) {
		const content = truncate(value.content.replace(/\s+\n/gu, "\n").trim(), c.contentMaxChars).text;
		if (content !== undefined && content.length > 0) shaped.content = content;
	}
	shaped.sources = sources;
	shaped.truncated = truncated;

	const after = JSON.stringify(shaped);
	return {
		value: shaped,
		stats: {
			charsBefore: before.length,
			charsAfter: after.length,
			tokensBefore: estimateTokens(before),
			tokensAfter: estimateTokens(after),
			sourcesBefore,
			sourcesAfter: sources.length,
		},
	};
}
