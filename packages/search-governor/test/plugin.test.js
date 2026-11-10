import { describe, it, expect, vi } from "vitest";
import { applyWith, Config, DEFAULT_BUDGET_NOTICE, GUIDANCE_SECTION_NAME, GUIDANCE_TEXT, inject, name, ledgerOf, nearDuplicateNotice, nearDuplicateNoteLine } from "../lib/index.js";
import { estimateTokens } from "@baoson/dsh-web-shared/text";
import { isVolatile, plainConfig } from "@baoson/dsh-web-shared/volatile";

/** Minimal cordis-like ctx capturing listeners. */
function fakeCtx() {
	const listeners = new Map();
	const sections = [];
	const debug = vi.fn();
	const warn = vi.fn();
	const info = vi.fn();
	return {
		ctx: {
			on(event, fn, opts) {
				if (!listeners.has(event)) listeners.set(event, []);
				listeners.get(event).push({ fn, opts });
				return () => {};
			},
			systemPrompt: { section(s) { sections.push(s); } },
			logger: { debug, warn, info },
			get() { return undefined; },
		},
		listeners, sections, debug, warn, info,
	};
}

const exec = (query, session = "s1", extra = {}) => ({
	name: "web_search",
	arguments: { query },
	callId: "c1",
	parent: undefined,
	agent: { session: { header: { id: session } } },
	...extra,
});

const okResult = (n = 8) => ({
	isError: false,
	value: {
		content: "answer ".repeat(400),
		sources: Array.from({ length: n }, (_, i) => ({ url: `https://e.com/${i}?utm_source=x`, title: `t${i}`, snippet: "z ".repeat(300) })),
		truncated: false,
	},
	content: [{ type: "text", text: "rendered" }],
	meta: { sources: [], truncated: false },
});

function mount(configPatch = {}, deps = {}) {
	const f = fakeCtx();
	const config = new Config(configPatch); // schemastery fills defaults
	const installSettings = vi.fn(); // seam: no dsh-settings import in tests
	const handles = applyWith(f.ctx, config, { installSettings, ...deps });
	const execArm = f.listeners.get("tools/execute")[0].fn;
	const postEntry = f.listeners.get("tools/post-execute")[0];
	return { ...f, config, handles, installSettings, execArm, post: postEntry.fn, postOpts: postEntry.opts };
}

describe("plugin wiring", () => {
	it("exports cordis plugin shape and registers guidance + hooks", () => {
		expect(name).toBe("web-search-governor");
		expect(inject).toEqual(["tools", "systemPrompt"]);
		const m = mount();
		expect(m.sections).toHaveLength(1);
		expect(m.sections[0]).toMatchObject({ name: GUIDANCE_SECTION_NAME, order: 111 });
		expect(m.sections[0].text).toContain("Using web search responsibly");
		expect(m.postOpts).toEqual({ prepend: true });
		expect(m.installSettings).toHaveBeenCalledTimes(1);
	});

	it("skips guidance when disabled", () => {
		expect(mount({ guidance: false }).sections).toHaveLength(0);
	});

	it("Config defaults match the README", () => {
		const parsed = new Config({});
		// Every field is `.volatile()` (editable from the dsh >= 0.2 settings UI): parsed values are references.
		for (const key of Object.keys(parsed)) expect(isVolatile(parsed[key]), key).toBe(true);
		const c = plainConfig(parsed);
		expect(c.maxSources).toBe(5);
		expect(c.snippetMaxChars).toBe(300);
		expect(c.contentMaxChars).toBe(1500);
		expect(c.budgetPerSession).toBe(10);
		expect(c.budgetNotice).toBe(DEFAULT_BUDGET_NOTICE);
		expect(c.providerOverrides).toEqual({ tavily: { snippetMaxChars: 800 } });
		expect(c.cache).toBe(true);
		expect(c.nearDuplicate).toBe(true);
		expect(c.nearDuplicateThreshold).toBe(0.5);
		expect(c.nearDuplicateMode).toBe("notice");
		expect(c.logAccounting).toBe(true);
		expect(() => new Config({ nearDuplicateMode: "shout" })).toThrow();
	});

	it("guidance mentions rephrased repeats", () => {
		expect(GUIDANCE_TEXT).toMatch(/Rephrased repeats of an earlier search are detected and flagged/u);
	});
});

describe("tools/execute arm", () => {
	it("passes through non-web_search and nested calls", async () => {
		const m = mount();
		const next = vi.fn(async () => "n");
		expect(await m.execArm({ name: "read", arguments: {} }, next)).toBe("n");
		expect(await m.execArm(exec("q", "s", { parent: { callId: "p" } }), next)).toBe("n");
		expect(next).toHaveBeenCalledTimes(2);
	});

	it("enforces the budget without calling next", async () => {
		const m = mount({ budgetPerSession: 2, cache: false });
		const next = vi.fn(async () => okResult());
		await m.execArm(exec("a"), next);
		await m.execArm(exec("b"), next);
		const denied = await m.execArm(exec("c"), next);
		expect(next).toHaveBeenCalledTimes(2);
		expect(denied.isError).toBe(false);
		expect(denied.value).toEqual({ content: DEFAULT_BUDGET_NOTICE, sources: [], truncated: false });
		expect(denied.content[0].text).toBe(DEFAULT_BUDGET_NOTICE);
		expect(denied.meta.governor).toEqual({ budgetExhausted: true, used: 2, limit: 2 });
		// other session unaffected
		expect(await m.execArm(exec("c", "s2"), next)).toEqual(okResult());
	});

	it("returns cached result for repeated query and does not spend budget", async () => {
		const m = mount({ budgetPerSession: 1 });
		const next = vi.fn(async () => okResult());
		const first = await m.execArm(exec("How to X"), next);
		const second = await m.execArm(exec("  how to x? "), next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(second.value).toBe(first.value);
		expect(second.meta).toEqual({ ...first.meta, governor: { cached: true } });
		expect(first.meta.governor).toBeUndefined(); // original not mutated
	});

	it("does not cache failures", async () => {
		const m = mount({ budgetPerSession: 0 });
		const next = vi.fn(async () => ({ isError: true, error: { code: "X", message: "m" }, content: [] }));
		await m.execArm(exec("q"), next);
		await m.execArm(exec("q"), next);
		expect(next).toHaveBeenCalledTimes(2);
	});

	it("falls through to next if the arm itself throws", async () => {
		const m = mount();
		m.handles.budget.consume = () => { throw new Error("boom"); };
		const next = vi.fn(async () => "ok");
		expect(await m.execArm(exec("q"), next)).toBe("ok");
		expect(m.warn).toHaveBeenCalled();
	});
});

describe("tools/post-execute arm", () => {
	it("shapes an accepted web_search value", async () => {
		const m = mount();
		const result = okResult(8);
		const decision = await m.post(exec("q"), result, async () => ({ kind: "accept" }));
		expect(decision.kind).toBe("accept");
		expect(decision.value.sources).toHaveLength(5);
		expect(decision.value.truncated).toBe(true);
		expect(decision.value.sources[0].url).toBe("https://e.com/0");
		expect(decision.value.sources[0].snippet.length).toBeLessThanOrEqual(300);
		expect(decision.value.content.length).toBeLessThanOrEqual(1500);
		expect(Object.hasOwn(decision, "content")).toBe(false);
		expect(m.debug).toHaveBeenCalled();
	});

	it("applies the active provider override", async () => {
		const m = mount({ activeProvider: "tavily" });
		const decision = await m.post(exec("q"), okResult(1), async () => ({ kind: "accept" }));
		expect(decision.value.sources[0].snippet.length).toBeGreaterThan(300);
		expect(decision.value.sources[0].snippet.length).toBeLessThanOrEqual(800);
	});

	it("shapes a downstream value replacement and keeps additionalContexts", async () => {
		const m = mount();
		const ac = [{ role: "user", content: "x" }];
		const decision = await m.post(exec("q"), okResult(1), async () => ({ kind: "accept", value: okResult(7).value, additionalContexts: ac }));
		expect(decision.value.sources).toHaveLength(5);
		expect(decision.additionalContexts).toBe(ac);
	});

	it("leaves other tools, nested calls, content replacements, blocks and errors alone", async () => {
		const m = mount();
		const accept = { kind: "accept" };
		expect(await m.post({ name: "read" }, okResult(), async () => accept)).toBe(accept);
		expect(await m.post(exec("q", "s", { parent: {} }), okResult(), async () => accept)).toBe(accept);
		const withContent = { kind: "accept", content: [{ type: "text", text: "x" }] };
		expect(await m.post(exec("q"), okResult(), async () => withContent)).toBe(withContent);
		const block = { kind: "block", feedback: [] };
		expect(await m.post(exec("q"), okResult(), async () => block)).toBe(block);
		expect(await m.post(exec("q"), { isError: true, error: {}, content: [] }, async () => accept)).toBe(accept);
	});
});

describe("near-duplicate detection", () => {
	/** Run execute then post-execute like the host does. */
	async function search(m, query, session, next = vi.fn(async () => okResult())) {
		const result = await m.execArm(exec(query, session), next);
		const decision = await m.post(exec(query, session), result, async () => ({ kind: "accept" }));
		return { result, decision, next };
	}

	it("notice mode: searches, but prepends one note line to the content", async () => {
		const m = mount();
		const first = await search(m, "node 24 fetch timeout", "s1");
		expect(first.decision.value.content.startsWith("Note:")).toBe(false);
		const second = await search(m, "node 24 fetch timeout setting", "s1");
		expect(second.next).toHaveBeenCalledTimes(1); // provider still called
		const [line, ...rest] = second.decision.value.content.split("\n");
		expect(line).toBe(nearDuplicateNoteLine("node 24 fetch timeout", 0.8));
		expect(line).toBe('Note: this query closely matches an earlier search ("node 24 fetch timeout", similarity 0.8); if the results overlap, stop searching and answer.');
		expect(rest.join("\n").startsWith("answer")).toBe(true);
		expect(m.handles.ledger.peek("s1").nearDuplicates).toBe(1);
		// unrelated query gets no note; other session unaffected
		const third = await search(m, "react server components", "s1");
		expect(third.decision.value.content.startsWith("Note:")).toBe(false);
		const other = await search(m, "node 24 fetch timeout setting", "s2");
		expect(other.decision.value.content.startsWith("Note:")).toBe(false);
	});

	it("notice mode: note is added even when the result has no content", async () => {
		const m = mount();
		await search(m, "alpha beta gamma", "s1");
		const r = { ...okResult(1), value: { sources: okResult(1).value.sources, truncated: false } };
		const second = await search(m, "alpha beta gamma delta", "s1", vi.fn(async () => r));
		expect(second.decision.value.content).toBe(nearDuplicateNoteLine("alpha beta gamma", 0.75));
	});

	it("block mode: returns the earlier cached result without calling next or spending budget", async () => {
		const m = mount({ nearDuplicateMode: "block", budgetPerSession: 1 });
		const first = await search(m, "node 24 fetch timeout", "s1");
		const next = vi.fn(async () => okResult());
		const blocked = await m.execArm(exec("node 24 fetch timeout setting", "s1"), next);
		expect(next).not.toHaveBeenCalled();
		expect(blocked.value).toBe(first.result.value);
		expect(blocked.meta.governor).toMatchObject({ cached: true, nearDuplicate: { of: "node 24 fetch timeout" } });
		expect(blocked.meta.governor.nearDuplicate.score).toBeCloseTo(0.8);
		expect(m.handles.budget.peek("s1").used).toBe(1);
		expect(m.handles.ledger.peek("s1").nearDuplicates).toBe(1);
	});

	it("block mode: returns a notice when the earlier result is no longer cached", async () => {
		let t = 0;
		const m = mount({ nearDuplicateMode: "block", cacheTtlMs: 10 }, { now: () => t });
		await search(m, "node 24 fetch timeout", "s1");
		t = 100; // cache expired, history remains
		const next = vi.fn(async () => okResult());
		const blocked = await m.execArm(exec("node 24 fetch timeouts", "s1"), next);
		expect(next).not.toHaveBeenCalled();
		const notice = nearDuplicateNotice("node 24 fetch timeout", 1);
		expect(notice).toContain('near-duplicate (similarity 1.00) of "node 24 fetch timeout"');
		expect(blocked).toEqual({
			isError: false,
			value: { content: notice, sources: [], truncated: false },
			content: [{ type: "text", text: notice }],
			meta: { sources: [], truncated: false, answer: notice, governor: { nearDuplicate: { of: "node 24 fetch timeout", score: 1 } } },
		});
	});

	it("block mode with cache disabled still blocks with a notice", async () => {
		const m = mount({ nearDuplicateMode: "block", cache: false });
		const next = vi.fn(async () => okResult());
		await m.execArm(exec("alpha beta gamma", "s1"), next);
		const blocked = await m.execArm(exec("alpha beta gamma delta", "s1"), next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(blocked.meta.governor.nearDuplicate.of).toBe("alpha beta gamma");
	});

	it("respects nearDuplicate: false and the threshold", async () => {
		const off = mount({ nearDuplicate: false });
		await search(off, "alpha beta gamma", "s1");
		expect((await search(off, "alpha beta gamma delta", "s1")).decision.value.content.startsWith("Note:")).toBe(false);
		const strict = mount({ nearDuplicateThreshold: 0.9 });
		await search(strict, "alpha beta gamma", "s1");
		expect((await search(strict, "alpha beta gamma delta", "s1")).decision.value.content.startsWith("Note:")).toBe(false);
	});

	it("identical queries hit the cache first and are not counted as near-duplicates", async () => {
		const m = mount();
		await search(m, "alpha beta gamma", "s1");
		const r = await search(m, "Alpha beta gamma!", "s1");
		expect(r.next).not.toHaveBeenCalled();
		expect(m.handles.ledger.peek("s1")).toMatchObject({ cacheHits: 1, nearDuplicates: 0 });
	});

	it("budget-blocked near-duplicate does not leave a stale note for a later search", async () => {
		const m = mount({ budgetPerSession: 1, budgetNotice: "stop" });
		await search(m, "alpha beta gamma", "s1");
		const denied = await m.execArm(exec("alpha beta gamma delta", "s1"), vi.fn(async () => okResult()));
		expect(denied.meta.governor.budgetExhausted).toBe(true);
		const d = await m.post(exec("alpha beta gamma delta", "s1"), denied, async () => ({ kind: "accept" }));
		expect(d.value.content).toBe("stop");
	});
});

describe("accounting", () => {
	it("keeps a per-session ledger exposed via handles and ledgerOf()", async () => {
		const m = mount({ budgetPerSession: 2 });
		const next = vi.fn(async () => okResult(8));
		const raw = estimateTokens(JSON.stringify(okResult(8).value));
		const r1 = await m.execArm(exec("alpha beta gamma", "s1"), next);
		const d1 = await m.post(exec("alpha beta gamma", "s1"), r1, async () => ({ kind: "accept" }));
		const shaped = estimateTokens(JSON.stringify(d1.value));
		expect(shaped).toBeLessThan(raw);
		expect(m.handles.ledger.peek("s1")).toEqual({ searches: 1, rawTokens: raw, shapedTokens: shaped, cacheHits: 0, budgetBlocks: 0, nearDuplicates: 0 });
		expect(ledgerOf("s1")).toBe(m.handles.ledger.peek("s1"));
		expect(ledgerOf("nope")).toBeUndefined();

		// cache hit: counted, but not as a search / tokens
		const r2 = await m.execArm(exec("alpha beta gamma", "s1"), next);
		await m.post(exec("alpha beta gamma", "s1"), r2, async () => ({ kind: "accept" }));
		expect(m.handles.ledger.peek("s1")).toMatchObject({ searches: 1, rawTokens: raw, cacheHits: 1 });

		// near-duplicate (notice) → second real search
		const r3 = await m.execArm(exec("alpha beta gamma delta", "s1"), next);
		await m.post(exec("alpha beta gamma delta", "s1"), r3, async () => ({ kind: "accept" }));
		expect(m.handles.ledger.peek("s1")).toMatchObject({ searches: 2, rawTokens: raw * 2, nearDuplicates: 1 });

		// budget block
		await m.execArm(exec("zeta eta theta", "s1"), next);
		expect(m.handles.ledger.peek("s1")).toMatchObject({ searches: 2, budgetBlocks: 1 });
		expect(next).toHaveBeenCalledTimes(2);
		expect(ledgerOf("s2")).toBeUndefined();
	});

	it("emits one structured info line per governed search in the documented format", async () => {
		const m = mount({ budgetPerSession: 10 });
		const r = await m.execArm(exec("alpha beta gamma", "s1"), vi.fn(async () => okResult(8)));
		await m.post(exec("alpha beta gamma", "s1"), r, async () => ({ kind: "accept" }));
		expect(m.info).toHaveBeenCalledTimes(1);
		const line = m.info.mock.calls[0][0];
		expect(line).toMatch(/^web_search governed: raw≈\d+ tok → \d+ tok \(−\d+%\), session 1\/10, cache miss$/u);
		const { rawTokens, shapedTokens } = m.handles.ledger.peek("s1");
		expect(line).toContain(`raw≈${rawTokens} tok → ${shapedTokens} tok (−${Math.round((1 - shapedTokens / rawTokens) * 100)}%)`);

		const r2 = await m.execArm(exec("alpha beta gamma", "s1"), vi.fn());
		await m.post(exec("alpha beta gamma", "s1"), r2, async () => ({ kind: "accept" }));
		expect(m.info.mock.calls[1][0]).toMatch(/session 1\/10, cache hit$/u);

		const r3 = await m.execArm(exec("alpha beta gamma delta", "s1"), vi.fn(async () => okResult(8)));
		await m.post(exec("alpha beta gamma delta", "s1"), r3, async () => ({ kind: "accept" }));
		expect(m.info.mock.calls[2][0]).toMatch(/session 2\/10, near-duplicate$/u);
	});

	it("shows ∞ for an unlimited budget and honours logAccounting: false", async () => {
		const m = mount({ budgetPerSession: 0 });
		const r = await m.execArm(exec("q", "s1"), vi.fn(async () => okResult()));
		await m.post(exec("q", "s1"), r, async () => ({ kind: "accept" }));
		expect(m.info.mock.calls[0][0]).toMatch(/session 1\/∞, cache miss$/u);

		const quiet = mount({ logAccounting: false });
		const r2 = await quiet.execArm(exec("q", "s1"), vi.fn(async () => okResult()));
		await quiet.post(exec("q", "s1"), r2, async () => ({ kind: "accept" }));
		expect(quiet.info).not.toHaveBeenCalled();
		expect(quiet.handles.ledger.peek("s1").searches).toBe(1); // ledger still kept
	});

	it("does not throw when ctx.logger is absent", async () => {
		const f = fakeCtx();
		delete f.ctx.logger;
		const handles = applyWith(f.ctx, new Config({}), { installSettings: vi.fn() });
		const arm = f.listeners.get("tools/execute")[0].fn;
		const post = f.listeners.get("tools/post-execute")[0].fn;
		const r = await arm(exec("q", "s1"), vi.fn(async () => okResult()));
		const d = await post(exec("q", "s1"), r, async () => ({ kind: "accept" }));
		expect(d.value.sources).toHaveLength(5);
		expect(handles.ledger.peek("s1").searches).toBe(1);
	});
});

describe("live settings seam", () => {
	it("reads config from the installed source at call time", async () => {
		const f = fakeCtx();
		let live = { ...new Config({}), budgetPerSession: 1 };
		const installSettings = (_ctx, _Schema, _config, setSource) => setSource(() => live);
		applyWith(f.ctx, new Config({}), { installSettings });
		const arm = f.listeners.get("tools/execute")[0].fn;
		const next = vi.fn(async () => okResult());
		await arm(exec("a"), next);
		expect((await arm(exec("b"), next)).meta.governor.budgetExhausted).toBe(true);
		live = { ...live, budgetPerSession: 0 };
		expect((await arm(exec("c"), next)).meta.governor).toBeUndefined();
	});
});
