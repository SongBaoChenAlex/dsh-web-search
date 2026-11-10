/**
 * Per-session query → result cache with TTL and per-session size cap.
 * @module @baoson/dsh-web-search-governor/cache
 */

/**
 * Normalize a query for cache lookup: lowercase, collapse whitespace, trim
 * surrounding punctuation / quotes.
 * @param {unknown} query
 * @returns {string}
 */
export function normalizeQuery(query) {
	if (typeof query !== "string") return "";
	return query
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/^[\s"'“”‘’`.,;:!?()[\]{}<>]+|[\s"'“”‘’`.,;:!?()[\]{}<>]+$/gu, "")
		.trim();
}

export class QueryCache {
	/**
	 * @param {{ ttlMs?: number | (() => number), maxPerSession?: number, maxSessions?: number, now?: () => number }} [options]
	 */
	constructor(options = {}) {
		const ttl = options.ttlMs ?? 30 * 60 * 1000;
		this.ttlSource = typeof ttl === "function" ? ttl : () => ttl;
		this.maxPerSession = Math.max(1, options.maxPerSession ?? 50);
		this.maxSessions = Math.max(1, options.maxSessions ?? 500);
		this.now = options.now ?? (() => Date.now());
		/** @type {Map<string, Map<string, { value: any, expiresAt: number }>>} */
		this.sessions = new Map();
	}

	get ttlMs() {
		const raw = Number(this.ttlSource());
		return Number.isFinite(raw) && raw > 0 ? raw : 0;
	}

	/** @param {string} sessionKey */
	bucket(sessionKey) {
		let bucket = this.sessions.get(sessionKey);
		if (bucket) {
			this.sessions.delete(sessionKey);
		} else {
			bucket = new Map();
		}
		this.sessions.set(sessionKey, bucket);
		while (this.sessions.size > this.maxSessions) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) break;
			this.sessions.delete(oldest);
		}
		return bucket;
	}

	/**
	 * @param {string} sessionKey
	 * @param {unknown} query
	 * @returns {any | undefined}
	 */
	get(sessionKey, query) {
		const key = normalizeQuery(query);
		if (key.length === 0) return undefined;
		const bucket = this.sessions.get(sessionKey);
		if (!bucket) return undefined;
		const entry = bucket.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			bucket.delete(key);
			return undefined;
		}
		// refresh LRU position within the bucket
		bucket.delete(key);
		bucket.set(key, entry);
		return entry.value;
	}

	/**
	 * @param {string} sessionKey
	 * @param {unknown} query
	 * @param {any} value
	 */
	set(sessionKey, query, value) {
		const key = normalizeQuery(query);
		const ttl = this.ttlMs;
		if (key.length === 0 || ttl === 0) return;
		const bucket = this.bucket(sessionKey);
		bucket.delete(key);
		bucket.set(key, { value, expiresAt: this.now() + ttl });
		while (bucket.size > this.maxPerSession) {
			const oldest = bucket.keys().next().value;
			if (oldest === undefined) break;
			bucket.delete(oldest);
		}
	}

	/** @param {string} [sessionKey] */
	clear(sessionKey) {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}

	/** @param {string} sessionKey */
	size(sessionKey) {
		return this.sessions.get(sessionKey)?.size ?? 0;
	}
}
