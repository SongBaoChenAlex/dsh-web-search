import { describe, it, expect } from "vitest";
import { tokenize, stem, jaccard, findNearDuplicate, QueryHistory } from "../lib/similarity.js";

describe("stem", () => {
	it("strips ing/ed/es/s only when ≥ 4 chars remain", () => {
		expect(stem("settings")).toBe("setting");
		expect(stem("timeouts")).toBe("timeout");
		expect(stem("configuring")).toBe("configur");
		expect(stem("fetched")).toBe("fetch");
		expect(stem("boxes")).toBe("boxe"); // "es" leaves 3 chars → skipped; "s" leaves 4 → stripped
		expect(stem("axes")).toBe("axes"); // nothing leaves ≥ 4 chars
		expect(stem("sing")).toBe("sing");
		expect(stem("node")).toBe("node");
	});
});

describe("tokenize", () => {
	it("lowercases, strips punctuation, drops stop-words and single chars, stems, dedupes", () => {
		expect(tokenize("How to set the Node.js fetch timeouts?")).toEqual(["node", "js", "fetch", "timeout"]);
		expect(tokenize("a b c")).toEqual([]);
		expect(tokenize("Fetch fetch FETCH!")).toEqual(["fetch"]);
		expect(tokenize(undefined)).toEqual([]);
		expect(tokenize(12)).toEqual([]);
	});
	it("keeps unicode letters and digits", () => {
		expect(tokenize("Vue 3 Composition API 教程")).toEqual(["vue", "composition", "api", "教程"]);
	});
});

describe("jaccard", () => {
	it("handles identical, disjoint and empty sets", () => {
		expect(jaccard(["a", "b"], ["b", "a"])).toBe(1);
		expect(jaccard(["a"], ["b"])).toBe(0);
		expect(jaccard([], [])).toBe(0);
		expect(jaccard(["a"], [])).toBe(0);
		expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
	});
});

describe("findNearDuplicate", () => {
	const prev = ["node 24 fetch timeout", "vitest mock timers", "pnpm workspace filter"];
	it("finds a rephrased repeat above the threshold", () => {
		expect(findNearDuplicate("node 24 fetch timeouts", prev, 0.6)).toEqual({ query: "node 24 fetch timeout", score: 1 });
		const dup = findNearDuplicate("node 24 fetch timeout setting", prev, 0.6);
		expect(dup.query).toBe("node 24 fetch timeout");
		expect(dup.score).toBeCloseTo(0.8);
		// "nodejs" does not stem to "node": 3 shared of 6 → 0.5, below 0.6 but caught at 0.5
		expect(findNearDuplicate("nodejs 24 fetch timeout setting", prev, 0.6)).toBeUndefined();
		expect(findNearDuplicate("nodejs 24 fetch timeout setting", prev, 0.5)).toMatchObject({ query: "node 24 fetch timeout", score: 0.5 });
	});
	it("returns undefined below the threshold, for empty input, or no history", () => {
		expect(findNearDuplicate("react server components", prev, 0.6)).toBeUndefined();
		expect(findNearDuplicate("the and of", prev, 0)).toBeUndefined();
		expect(findNearDuplicate("node 24 fetch timeout", [], 0.6)).toBeUndefined();
		expect(findNearDuplicate("node 24 fetch timeout", undefined, 0.6)).toBeUndefined();
	});
	it("threshold edge cases: exactly at threshold matches; threshold 1 needs identical token sets; bad threshold defaults to 0.5", () => {
		expect(findNearDuplicate("alpha beta gamma delta", ["alpha beta gamma epsilon"], 0.6)).toEqual({ query: "alpha beta gamma epsilon", score: 0.6 });
		expect(findNearDuplicate("alpha beta gamma delta", ["alpha beta gamma epsilon"], 0.61)).toBeUndefined();
		expect(findNearDuplicate("alpha beta", ["beta alpha", "alpha beta gamma"], 1)).toEqual({ query: "beta alpha", score: 1 });
		expect(findNearDuplicate("alpha beta gamma delta", ["alpha beta gamma epsilon"], Number.NaN)).toBeDefined();
		expect(findNearDuplicate("alpha beta gamma delta", ["alpha beta"], 0.4)).toEqual({ query: "alpha beta", score: 0.5 });
	});
	it("picks the best match, most recent on ties", () => {
		expect(findNearDuplicate("alpha beta", ["alpha beta gamma", "alpha beta"], 0.5).query).toBe("alpha beta");
		expect(findNearDuplicate("alpha beta", ["alpha beta", "beta alpha"], 0.5).query).toBe("beta alpha");
	});
});

describe("QueryHistory", () => {
	it("is bounded per session and isolated across sessions", () => {
		const h = new QueryHistory({ maxPerSession: 2, maxSessions: 2 });
		h.push("s1", "a");
		h.push("s1", "b");
		h.push("s1", "c");
		expect(h.list("s1")).toEqual(["b", "c"]);
		expect(h.list("s2")).toEqual([]);
		h.push("s2", "x");
		h.push("s3", "y"); // evicts s1 (LRU)
		expect(h.list("s1")).toEqual([]);
		expect(h.list("s2")).toEqual(["x"]);
		h.push("s2", "   ");
		h.push("s2", 5);
		expect(h.list("s2")).toEqual(["x"]);
		h.clear("s2");
		expect(h.list("s2")).toEqual([]);
	});
});
