/**
 * Pure near-duplicate query detection: tokenize → light stem → Jaccard.
 * No I/O, no DSH imports.
 * @module @tobedone4byme/dsh-web-search-governor/similarity
 */

/** Small English stop-word list; single-character tokens are dropped separately. */
export const STOP_WORDS = new Set([
	"a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "to", "in", "on", "at", "by", "for",
	"from", "with", "without", "into", "onto", "about", "as", "is", "are", "was", "were", "be", "been", "being",
	"do", "does", "did", "how", "what", "when", "where", "which", "who", "why", "this", "that", "these", "those",
	"it", "its", "my", "your", "our", "their", "i", "you", "we", "they", "me", "us", "them", "can", "could",
	"should", "would", "will", "shall", "may", "might", "must", "not", "no", "vs", "via", "per", "any", "some",
	"up", "out", "so", "than", "too", "very", "just", "get", "set", "use", "using", "used",
]);

/**
 * Light stemming: strip a trailing `ing` / `ed` / `es` / `s` when the remainder
 * stays at least 4 characters long. Longer suffixes are tried first.
 * @param {string} token
 * @returns {string}
 */
export function stem(token) {
	for (const suffix of ["ing", "ed", "es", "s"]) {
		if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
	}
	return token;
}

/**
 * Lowercase, strip punctuation, split on whitespace, drop stop-words and
 * single characters, stem. Returns a deduplicated token list (order kept).
 * @param {unknown} query
 * @returns {string[]}
 */
export function tokenize(query) {
	if (typeof query !== "string") return [];
	const words = query
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.split(/\s+/u)
		.filter((w) => w.length > 1 && !STOP_WORDS.has(w))
		.map(stem);
	return [...new Set(words)];
}

/**
 * Jaccard similarity of two token lists (|A∩B| / |A∪B|). Two empty lists → 0.
 * @param {string[]} aTokens
 * @param {string[]} bTokens
 * @returns {number}
 */
export function jaccard(aTokens, bTokens) {
	const a = new Set(aTokens);
	const b = new Set(bTokens);
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

/**
 * Best near-duplicate of `query` among `previousQueries` whose Jaccard score
 * is ≥ `threshold`. Ties resolve to the most recent (last) query.
 * @param {unknown} query
 * @param {Iterable<string>} previousQueries
 * @param {number} [threshold]
 * @returns {{ query: string, score: number } | undefined}
 */
export function findNearDuplicate(query, previousQueries, threshold = 0.5) {
	const tokens = tokenize(query);
	if (tokens.length === 0) return undefined;
	const t = Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.5;
	/** @type {{ query: string, score: number } | undefined} */
	let best;
	for (const prev of previousQueries ?? []) {
		if (typeof prev !== "string") continue;
		const score = jaccard(tokens, tokenize(prev));
		if (score >= t && (best === undefined || score >= best.score)) best = { query: prev, score };
	}
	return best;
}

/**
 * Per-session bounded history of raw queries (LRU on sessions, FIFO within a session).
 */
export class QueryHistory {
	/** @param {{ maxPerSession?: number, maxSessions?: number }} [options] */
	constructor(options = {}) {
		this.maxPerSession = Math.max(1, options.maxPerSession ?? 50);
		this.maxSessions = Math.max(1, options.maxSessions ?? 500);
		/** @type {Map<string, string[]>} */
		this.sessions = new Map();
	}

	/**
	 * @param {string} sessionKey
	 * @returns {readonly string[]}
	 */
	list(sessionKey) {
		return this.sessions.get(sessionKey) ?? [];
	}

	/**
	 * @param {string} sessionKey
	 * @param {unknown} query
	 */
	push(sessionKey, query) {
		if (typeof query !== "string" || query.trim().length === 0) return;
		let list = this.sessions.get(sessionKey);
		if (list) this.sessions.delete(sessionKey);
		else list = [];
		this.sessions.set(sessionKey, list);
		list.push(query.trim());
		while (list.length > this.maxPerSession) list.shift();
		while (this.sessions.size > this.maxSessions) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) break;
			this.sessions.delete(oldest);
		}
	}

	/** @param {string} [sessionKey] */
	clear(sessionKey) {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
