import { describe, it, expect } from "vitest";
import {
	CompositeFetchProvider,
	COMPOSITE_FETCH_PROVIDER_ID,
	Config,
	DEFAULTS,
	apply,
	inject,
	isThin,
	name,
	textLengthOf,
} from "../lib/index.js";

const LONG = "lorem ipsum dolor sit amet ".repeat(40); // ~1080 chars
const SHORT = "hello";

function html(text, status = 200) {
	return { url: "https://x.test/", statusCode: status, body: { kind: "html", content: `<html><body><p>${text}</p></body></html>` }, truncated: false };
}
function text(content, status = 200) {
	return { url: "https://x.test/", statusCode: status, body: { kind: "text", content }, truncated: false };
}

/**
 * @param {string} id
 * @param {(request: any, signal?: AbortSignal) => any} impl  return value or thrown error
 */
function fake(id, impl, available = true) {
	const calls = [];
	return {
		id,
		calls,
		available: () => available,
		async fetch(request, signal) {
			calls.push(request.url);
			const r = typeof impl === "function" ? impl(request, signal) : impl;
			if (r instanceof Error) throw r;
			return r;
		},
	};
}

function makeWeb(...providers) {
	const web = {
		fetchProviders: new Map(),
		registerFetchProvider(p) { web.fetchProviders.set(p.id, p); },
	};
	for (const p of providers) web.registerFetchProvider(p);
	return web;
}

function composite(web, overrides = {}) {
	const p = new CompositeFetchProvider(web, () => ({ chain: ["a", "b"], ...overrides }));
	web.registerFetchProvider(p);
	return p;
}

const REQ = { url: "https://x.test/" };

describe("metadata", () => {
	it("exposes plugin name / inject / schema defaults", () => {
		expect(name).toBe("web-fetch-composite");
		expect(inject).toEqual(["web"]);
		const cfg = Config({});
		expect(cfg.chain).toEqual(["readability-http", "tavily-extract"]);
		expect(cfg.minTextChars).toBe(400);
		expect(cfg.fallbackOnStatus).toEqual([403, 429, 451, 500, 502, 503]);
		expect(cfg.fallbackOnError).toBe(true);
		expect(cfg.notice).toBe(true);
		expect(DEFAULTS.minTextChars).toBe(400);
	});

	it("apply() registers under id composite", () => {
		const web = makeWeb();
		apply({ web, logger: { warn() {} } }, Config({}));
		expect(web.fetchProviders.get(COMPOSITE_FETCH_PROVIDER_ID)).toBeInstanceOf(CompositeFetchProvider);
	});
});

describe("textLengthOf / isThin", () => {
	it("strips tags, scripts, comments and entities for html", () => {
		const r = { body: { kind: "html", content: "<!-- c --><script>var x = 1;</script><style>p{}</style><p>Hi&nbsp;there</p>" } };
		expect(textLengthOf(r)).toBe("Hi there".length);
	});
	it("uses raw collapsed text for text", () => {
		expect(textLengthOf({ body: { kind: "text", content: "  a   b \n c " } })).toBe(5);
		expect(textLengthOf(undefined)).toBe(0);
	});
	it("thin threshold", () => {
		expect(isThin(text("abc"), 4)).toBe(true);
		expect(isThin(text("abcd"), 4)).toBe(false);
		expect(isThin(text(""), 0)).toBe(false); // disabled
	});
});

describe("CompositeFetchProvider", () => {
	it("primary good → returned untouched, no fallback", async () => {
		const a = fake("a", html(LONG));
		const b = fake("b", text(LONG));
		const c = composite(makeWeb(a, b));
		const r = await c.fetch(REQ);
		expect(r).toEqual(html(LONG));
		expect(a.calls).toHaveLength(1);
		expect(b.calls).toHaveLength(0);
	});

	it("thin primary → fallback with notice", async () => {
		const a = fake("a", html(SHORT));
		const b = fake("b", text(LONG));
		const c = composite(makeWeb(a, b));
		const r = await c.fetch(REQ);
		expect(b.calls).toHaveLength(1);
		expect(r.statusCode).toBe(200);
		expect(r.body.kind).toBe("text");
		const [first, ...rest] = r.body.content.split("\n");
		expect(first).toMatch(/^\[fetched via b after a returned thin content \(5 chars\)\]$/u);
		expect(rest.join("\n")).toBe(LONG);
	});

	it("html winner gets an HTML comment notice; notice:false leaves body untouched", async () => {
		const a = fake("a", new Error("boom"));
		const b = fake("b", html(LONG));
		const r = await composite(makeWeb(a, b)).fetch(REQ);
		expect(r.body.content.split("\n")[0]).toBe("<!-- fetched via b after a returned error: boom -->");

		const r2 = await composite(makeWeb(fake("a", new Error("boom")), fake("b", html(LONG))), { notice: false }).fetch(REQ);
		expect(r2).toEqual(html(LONG));
	});

	it("primary throws → fallback (fallbackOnError true)", async () => {
		const a = fake("a", new Error("ECONNRESET"));
		const b = fake("b", text(LONG));
		const r = await composite(makeWeb(a, b)).fetch(REQ);
		expect(b.calls).toHaveLength(1);
		expect(r.body.content).toContain(LONG);
	});

	it("primary throws with fallbackOnError:false → rethrown", async () => {
		const err = new Error("nope");
		const a = fake("a", err);
		const b = fake("b", text(LONG));
		await expect(composite(makeWeb(a, b), { fallbackOnError: false }).fetch(REQ)).rejects.toBe(err);
		expect(b.calls).toHaveLength(0);
	});

	it("status 403 → fallback", async () => {
		const a = fake("a", text(LONG, 403));
		const b = fake("b", text(LONG));
		const r = await composite(makeWeb(a, b)).fetch(REQ);
		expect(b.calls).toHaveLength(1);
		expect(r.body.content.split("\n")[0]).toBe("[fetched via b after a returned HTTP 403]");
	});

	it("status 404 is not in the default list → returned from primary", async () => {
		const a = fake("a", text(LONG, 404));
		const b = fake("b", text(LONG));
		const r = await composite(makeWeb(a, b)).fetch(REQ);
		expect(r.statusCode).toBe(404);
		expect(b.calls).toHaveLength(0);
	});

	it("all thin → longest wins (not the last)", async () => {
		const a = fake("a", text("twelve chars"));
		const b = fake("b", text("tiny"));
		const r = await composite(makeWeb(a, b)).fetch(REQ);
		const [notice, ...body] = r.body.content.split("\n");
		expect(body.join("\n")).toBe("twelve chars");
		expect(notice).toContain("fetched via a");
		expect(notice).toContain("all providers thin");
	});

	it("unavailable provider is skipped", async () => {
		const a = fake("a", text(LONG), false);
		const b = fake("b", text(LONG));
		const c = composite(makeWeb(a, b));
		const r = await c.fetch(REQ);
		expect(a.calls).toHaveLength(0);
		expect(b.calls).toHaveLength(1);
		expect(r).toEqual(text(LONG)); // b was effectively the primary: no notice
	});

	it("missing ids and self are skipped (no recursion)", async () => {
		const b = fake("b", text(LONG));
		const web = makeWeb(b);
		const c = composite(web, { chain: ["composite", "ghost", "b"] });
		const r = await c.fetch(REQ);
		expect(r).toEqual(text(LONG));
		expect(c.resolveChain().map((x) => x.id)).toEqual(["b"]);
	});

	it("available() reflects the chain", () => {
		expect(composite(makeWeb()).available()).toBe(false);
		expect(composite(makeWeb(fake("a", text(LONG), false))).available()).toBe(false);
		expect(composite(makeWeb(fake("b", text(LONG)))).available()).toBe(true);
	});

	it("none usable → WEB_PROVIDER_ERROR", async () => {
		await expect(composite(makeWeb()).fetch(REQ)).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" });
	});

	it("every provider fails → WEB_PROVIDER_ERROR listing reasons", async () => {
		const a = fake("a", new Error("boom"));
		const b = fake("b", text("x", 503));
		await expect(composite(makeWeb(a, b)).fetch(REQ)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringMatching(/a: error: boom; b: HTTP 503/u),
		});
	});

	it("abort between attempts is honoured", async () => {
		const ac = new AbortController();
		const a = fake("a", () => { ac.abort(new Error("user cancelled")); return html(SHORT); });
		const b = fake("b", text(LONG));
		await expect(composite(makeWeb(a, b)).fetch(REQ, ac.signal)).rejects.toMatchObject({ code: "WEB_ABORTED" });
		expect(b.calls).toHaveLength(0);
	});

	it("abort error thrown by a provider propagates as WEB_ABORTED, not fallback", async () => {
		const err = new Error("aborted"); err.name = "AbortError";
		const a = fake("a", err);
		const b = fake("b", text(LONG));
		await expect(composite(makeWeb(a, b)).fetch(REQ)).rejects.toMatchObject({ code: "WEB_ABORTED" });
		expect(b.calls).toHaveLength(0);
	});

	it("already-aborted signal rejects before any attempt", async () => {
		const a = fake("a", text(LONG));
		const ac = new AbortController(); ac.abort();
		await expect(composite(makeWeb(a)).fetch(REQ, ac.signal)).rejects.toMatchObject({ code: "WEB_ABORTED" });
		expect(a.calls).toHaveLength(0);
	});

	it("resolves providers lazily (registered after composite)", async () => {
		const web = makeWeb();
		const c = composite(web);
		expect(c.available()).toBe(false);
		web.registerFetchProvider(fake("a", text(LONG)));
		expect(c.available()).toBe(true);
		expect(await c.fetch(REQ)).toEqual(text(LONG));
	});
});
