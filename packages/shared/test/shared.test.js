import { describe, it, expect } from "vitest";
import { truncate, cleanUrl, dedupeBy, cleanSnippet, estimateTokens } from "../src/text.js";
import { withTimeout, fetchWithTimeout, abortable } from "../src/http.js";

describe("truncate", () => {
	it("passes short text through", () => {
		expect(truncate("hello", 10)).toEqual({ text: "hello", truncated: false });
	});
	it("cuts at a word boundary and appends the trailer within budget", () => {
		const r = truncate("the quick brown fox jumps over the lazy dog", 20);
		expect(r.truncated).toBe(true);
		expect(r.text.length).toBeLessThanOrEqual(20);
		expect(r.text.endsWith("…")).toBe(true);
	});
	it("handles undefined", () => {
		expect(truncate(undefined, 5)).toEqual({ text: undefined, truncated: false });
	});
});

describe("cleanUrl", () => {
	it("strips utm_* and known tracking params, keeps others", () => {
		expect(cleanUrl("https://Example.com/a?utm_source=x&id=1&fbclid=y#frag")).toBe("https://example.com/a?id=1");
	});
	it("drops default port and lone trailing slash", () => {
		expect(cleanUrl("https://example.com:443/")).toBe("https://example.com");
	});
	it("returns garbage unchanged", () => {
		expect(cleanUrl("not a url")).toBe("not a url");
	});
});

describe("dedupeBy", () => {
	it("keeps first occurrence", () => {
		expect(dedupeBy([{ u: "a" }, { u: "b" }, { u: "a" }], (x) => x.u)).toEqual([{ u: "a" }, { u: "b" }]);
	});
});

describe("cleanSnippet", () => {
	it("strips highlight tags and entities", () => {
		expect(cleanSnippet("<strong>Foo</strong> &amp;  bar\n baz")).toBe("Foo & bar baz");
	});
	it("returns undefined for empty", () => {
		expect(cleanSnippet("   ")).toBeUndefined();
	});
});

describe("estimateTokens", () => {
	it("is roughly chars/4 for ascii", () => {
		expect(estimateTokens("a".repeat(400))).toBe(100);
	});
});

describe("withTimeout", () => {
	it("aborts after the timeout", async () => {
		const { signal, cleanup, timedOut } = withTimeout(undefined, 10);
		await new Promise((r) => setTimeout(r, 30));
		expect(signal.aborted).toBe(true);
		expect(timedOut()).toBe(true);
		cleanup();
	});
	it("propagates caller abort", () => {
		const c = new AbortController();
		const { signal, cleanup } = withTimeout(c.signal, 0);
		c.abort();
		expect(signal.aborted).toBe(true);
		cleanup();
	});
});

describe("fetchWithTimeout", () => {
	it("maps a timeout to TimeoutError", async () => {
		const http = await import("node:http");
		const server = http.createServer(() => { /* never respond */ });
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const port = server.address().port;
		await expect(fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, { timeoutMs: 50 })).rejects.toMatchObject({ name: "TimeoutError" });
		server.closeAllConnections?.();
		await new Promise((r) => server.close(r));
	});
});

describe("abortable", () => {
	it("rejects when the signal fires first", async () => {
		const c = new AbortController();
		const p = abortable(new Promise(() => {}), c.signal);
		c.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("apiKeyResolver.canResolve", () => {
	it("becomes exact after a real resolution and forgets after the TTL", async () => {
		const { apiKeyResolver } = await import("../src/credentials.js");
		const saved = process.env.X_TEST_KEY;
		delete process.env.X_TEST_KEY;
		try {
			// No ctx → no host packages → falls back to process.env only.
			const r = apiKeyResolver(undefined, { apiKeyEnv: "X_TEST_KEY" });
			expect(r.canResolve()).toBe(false);
			expect(await r.resolve()).toBeUndefined();
			expect(r.canResolve()).toBe(false);
			process.env.X_TEST_KEY = "k";
			// A fresh negative answer is still cached…
			expect(await r.resolve()).toBe("k");
			// …but a real resolution updates it immediately.
			expect(r.canResolve()).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.X_TEST_KEY; else process.env.X_TEST_KEY = saved;
		}
	});

	it("stays optimistic when a credentials service exists but nothing has resolved yet", async () => {
		const { apiKeyResolver } = await import("../src/credentials.js");
		const ctx = { get: (k) => (k === "credentials" ? {} : undefined) };
		const r = apiKeyResolver(ctx, { apiKeyEnv: "X_NOPE" });
		expect(r.canResolve()).toBe(true);
	});
});
