import { describe, it, expect } from "vitest";
import { SessionBudget } from "../lib/budget.js";

describe("SessionBudget", () => {
	it("allows the 10th call and denies the 11th", () => {
		const b = new SessionBudget(10);
		let last;
		for (let i = 0; i < 10; i++) last = b.consume("s1");
		expect(last).toEqual({ allowed: true, used: 10, limit: 10 });
		expect(b.consume("s1")).toEqual({ allowed: false, used: 10, limit: 10 });
		expect(b.consume("s1").used).toBe(10); // denied calls do not count
		expect(b.peek("s1")).toEqual({ used: 10, limit: 10, remaining: 0 });
	});

	it("keeps sessions independent and supports reset", () => {
		const b = new SessionBudget(1);
		expect(b.consume("a").allowed).toBe(true);
		expect(b.consume("b").allowed).toBe(true);
		expect(b.consume("a").allowed).toBe(false);
		b.reset("a");
		expect(b.consume("a").allowed).toBe(true);
		expect(b.consume("b").allowed).toBe(false);
		b.reset();
		expect(b.consume("b").allowed).toBe(true);
	});

	it("0 means unlimited", () => {
		const b = new SessionBudget(0);
		for (let i = 0; i < 100; i++) expect(b.consume("s").allowed).toBe(true);
		expect(b.peek("s").remaining).toBe(Number.POSITIVE_INFINITY);
	});

	it("reads a live limit thunk", () => {
		let limit = 1;
		const b = new SessionBudget(() => limit);
		expect(b.consume("s").allowed).toBe(true);
		expect(b.consume("s").allowed).toBe(false);
		limit = 3;
		expect(b.consume("s").allowed).toBe(true);
	});

	it("evicts least-recently-used sessions beyond maxSessions", () => {
		const b = new SessionBudget(1, { maxSessions: 2 });
		b.consume("a");
		b.consume("b");
		b.consume("c"); // evicts a
		expect(b.peek("a").used).toBe(0);
		expect(b.used.size).toBe(2);
	});
});
