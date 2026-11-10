/**
 * Per-session call counter (same semantics as the search governor's
 * `SessionBudget`, duplicated here so this package has no dependency on it).
 * @module @baoson/dsh-web-tavily-tools/budget
 */
export class SessionBudget {
	/**
	 * @param {number | (() => number)} limit  calls allowed per session; `0` = unlimited.
	 * @param {{ maxSessions?: number }} [options]
	 */
	constructor(limit, options = {}) {
		this.limitSource = typeof limit === "function" ? limit : () => limit;
		this.maxSessions = Math.max(1, options.maxSessions ?? 500);
		/** @type {Map<string, number>} insertion order == LRU order */
		this.used = new Map();
	}

	get limit() {
		const raw = Number(this.limitSource());
		return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
	}

	/**
	 * @param {string} sessionKey
	 * @returns {{ allowed: boolean, used: number, limit: number }}
	 */
	consume(sessionKey) {
		const limit = this.limit;
		const used = this.used.get(sessionKey) ?? 0;
		this.used.delete(sessionKey);
		this.used.set(sessionKey, used);
		while (this.used.size > this.maxSessions) {
			const oldest = this.used.keys().next().value;
			if (oldest === undefined) break;
			this.used.delete(oldest);
		}
		if (limit !== 0 && used >= limit) return { allowed: false, used, limit };
		this.used.set(sessionKey, used + 1);
		return { allowed: true, used: used + 1, limit };
	}

	/** @param {string} [sessionKey] omit to reset every session. */
	reset(sessionKey) {
		if (sessionKey === undefined) this.used.clear();
		else this.used.delete(sessionKey);
	}
}
