import { describe, it, expect } from "vitest";
import { QueryCache, normalizeQuery } from "../lib/cache.js";

describe("normalizeQuery", () => {
	it("lowercases, collapses whitespace, trims punctuation", () => {
		expect(normalizeQuery('  "How to   Configure X?" ')).toBe("how to configure x");
		expect(normalizeQuery("x configuration.")).toBe("x configuration");
		expect(normalizeQuery(42)).toBe("");
	});
});

describe("QueryCache", () => {
	it("hit / miss and normalization", () => {
		const c = new QueryCache();
		expect(c.get("s", "foo")).toBeUndefined();
		c.set("s", "Foo  Bar", { v: 1 });
		expect(c.get("s", "foo bar")).toEqual({ v: 1 });
		expect(c.get("s", "foo bar!")).toEqual({ v: 1 });
		expect(c.get("other", "foo bar")).toBeUndefined();
	});

	it("expires after ttl", () => {
		let t = 1000;
		const c = new QueryCache({ ttlMs: 100, now: () => t });
		c.set("s", "q", 1);
		t = 1099;
		expect(c.get("s", "q")).toBe(1);
		t = 1100;
		expect(c.get("s", "q")).toBeUndefined();
	});

	it("ttl 0 disables storing", () => {
		const c = new QueryCache({ ttlMs: 0 });
		c.set("s", "q", 1);
		expect(c.get("s", "q")).toBeUndefined();
	});

	it("caps entries per session (LRU)", () => {
		const c = new QueryCache({ maxPerSession: 2 });
		c.set("s", "a", 1);
		c.set("s", "b", 2);
		c.get("s", "a"); // refresh a
		c.set("s", "c", 3); // evicts b
		expect(c.get("s", "b")).toBeUndefined();
		expect(c.get("s", "a")).toBe(1);
		expect(c.size("s")).toBe(2);
	});

	it("ignores empty queries and supports clear", () => {
		const c = new QueryCache();
		c.set("s", "   ", 1);
		expect(c.size("s")).toBe(0);
		c.set("s", "q", 1);
		c.clear("s");
		expect(c.get("s", "q")).toBeUndefined();
	});
});
