/**
 * Per-session call counter with an LRU bound on the number of tracked sessions.
 * @module @baoson/dsh-web-search-governor/budget
 */

export class SessionBudget {
	/**
	 * @param {number | (() => number)} limit  calls allowed per session; `0` = unlimited.
	 *   A thunk is re-evaluated on every call so live settings changes apply.
	 * @param {{ maxSessions?: number }} [options]
	 */
	constructor(limit, options = {}) {
		this.limitSource = typeof limit === "function" ? limit : () => limit;
		this.maxSessions = Math.max(1, options.maxSessions ?? 500);
		/** @type {Map<string, number>} insertion order == LRU order */
		this.used = new Map();
	}

	/** Current limit, normalized to a non-negative integer (`0` = unlimited). */
	get limit() {
		const raw = Number(this.limitSource());
		return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
	}

	/** @param {string} sessionKey */
	touch(sessionKey) {
		const count = this.used.get(sessionKey) ?? 0;
		if (this.used.has(sessionKey)) this.used.delete(sessionKey);
		this.used.set(sessionKey, count);
		while (this.used.size > this.maxSessions) {
			const oldest = this.used.keys().next().value;
			if (oldest === undefined) break;
			this.used.delete(oldest);
		}
		return count;
	}

	/**
	 * Try to spend one call. Only counts when allowed, so denied calls do not
	 * inflate `used`.
	 * @param {string} sessionKey
	 * @returns {{ allowed: boolean, used: number, limit: number }}
	 */
	consume(sessionKey) {
		const limit = this.limit;
		const used = this.touch(sessionKey);
		if (limit !== 0 && used >= limit) return { allowed: false, used, limit };
		this.used.set(sessionKey, used + 1);
		return { allowed: true, used: used + 1, limit };
	}

	/**
	 * @param {string} sessionKey
	 * @returns {{ used: number, limit: number, remaining: number }}
	 */
	peek(sessionKey) {
		const limit = this.limit;
		const used = this.used.get(sessionKey) ?? 0;
		return { used, limit, remaining: limit === 0 ? Number.POSITIVE_INFINITY : Math.max(0, limit - used) };
	}

	/** @param {string} [sessionKey]  omit to reset every session. */
	reset(sessionKey) {
		if (sessionKey === undefined) this.used.clear();
		else this.used.delete(sessionKey);
	}
}
