/**
 * Per-session token-accounting ledger, LRU-bounded on sessions.
 * @module @tobedone4byme/dsh-web-search-governor/ledger
 */

/**
 * @typedef {object} LedgerEntry
 * @property {number} searches        provider searches that were shaped (cache hits excluded)
 * @property {number} rawTokens       estimated tokens of provider results before shaping
 * @property {number} shapedTokens    estimated tokens after shaping
 * @property {number} cacheHits       identical-query cache hits
 * @property {number} budgetBlocks    searches refused because the budget was exhausted
 * @property {number} nearDuplicates  near-duplicate queries detected (notice or block)
 */

/** @returns {LedgerEntry} */
export function emptyLedgerEntry() {
	return { searches: 0, rawTokens: 0, shapedTokens: 0, cacheHits: 0, budgetBlocks: 0, nearDuplicates: 0 };
}

export class SessionLedger {
	/** @param {{ maxSessions?: number }} [options] */
	constructor(options = {}) {
		this.maxSessions = Math.max(1, options.maxSessions ?? 500);
		/** @type {Map<string, LedgerEntry>} insertion order == LRU order */
		this.sessions = new Map();
	}

	/**
	 * Entry for a session, created on demand (live object — mutations are visible).
	 * @param {string} sessionKey
	 * @returns {LedgerEntry}
	 */
	get(sessionKey) {
		let entry = this.sessions.get(sessionKey);
		if (entry) this.sessions.delete(sessionKey);
		else entry = emptyLedgerEntry();
		this.sessions.set(sessionKey, entry);
		while (this.sessions.size > this.maxSessions) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) break;
			this.sessions.delete(oldest);
		}
		return entry;
	}

	/**
	 * Read without creating.
	 * @param {string} sessionKey
	 * @returns {LedgerEntry | undefined}
	 */
	peek(sessionKey) {
		return this.sessions.get(sessionKey);
	}

	/**
	 * @param {string} sessionKey
	 * @param {Partial<LedgerEntry>} delta
	 * @returns {LedgerEntry}
	 */
	add(sessionKey, delta) {
		const entry = this.get(sessionKey);
		for (const key of Object.keys(delta)) {
			const v = Number(delta[key]);
			if (Object.hasOwn(entry, key) && Number.isFinite(v)) entry[key] += v;
		}
		return entry;
	}

	/** @param {string} [sessionKey] */
	reset(sessionKey) {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
