import { describe, it, expect } from "vitest";
import { SessionLedger, emptyLedgerEntry } from "../lib/ledger.js";

describe("SessionLedger", () => {
	it("accumulates known counters, ignores unknown or non-numeric ones", () => {
		const l = new SessionLedger();
		expect(l.peek("s")).toBeUndefined();
		l.add("s", { searches: 1, rawTokens: 1000, shapedTokens: 200 });
		l.add("s", { searches: 1, rawTokens: 500, shapedTokens: 100, bogus: 9, cacheHits: "x" });
		expect(l.peek("s")).toEqual({ ...emptyLedgerEntry(), searches: 2, rawTokens: 1500, shapedTokens: 300 });
		expect(Object.hasOwn(l.peek("s"), "bogus")).toBe(false);
	});
	it("is LRU-bounded on sessions and resettable", () => {
		const l = new SessionLedger({ maxSessions: 2 });
		l.add("a", { searches: 1 });
		l.add("b", { searches: 1 });
		l.add("a", { searches: 1 }); // refresh a
		l.add("c", { searches: 1 }); // evicts b
		expect(l.peek("b")).toBeUndefined();
		expect(l.peek("a").searches).toBe(2);
		l.reset("a");
		expect(l.peek("a")).toBeUndefined();
		l.reset();
		expect(l.sessions.size).toBe(0);
	});
});
