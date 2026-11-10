import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { download, RedirectError } from "../lib/download.js";
import { ReadabilityFetchProvider, READABILITY_FETCH_PROVIDER_ID, isAllowedType, name, inject, Config } from "../lib/index.js";
import { BlockedUrlError } from "../lib/ssrf.js";
import { ARTICLE_HTML, GB2312_BYTES, NON_ARTICLE_HTML, fakeLookup, startFixtureServer } from "./fixtures.js";

const BIG_BYTES = 8 * 1024 * 1024;
const CAP = 5 * 1024 * 1024;

let server;
let base;
let stallSockets = [];

beforeAll(async () => {
	server = await startFixtureServer({
		"/article": { body: ARTICLE_HTML },
		"/index": { body: NON_ARTICLE_HTML },
		"/gb2312": { headers: { "content-type": "text/html" }, body: GB2312_BYTES },
		"/plain": { headers: { "content-type": "text/plain; charset=utf-8" }, body: "just some text\nline two" },
		"/json": { headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, n: 1 }) },
		"/pdf": { headers: { "content-type": "application/pdf" }, body: Buffer.from("%PDF-1.4 fake") },
		"/png": { headers: { "content-type": "image/png" }, body: Buffer.alloc(300, 0) },
		"/missing": { status: 404, headers: { "content-type": "text/html" }, body: "<html><body><h1>Not Found</h1><p>Nothing here</p></body></html>" },
		"/error": { status: 500, headers: { "content-type": "application/json" }, body: '{"error":"boom"}' },
		"/big": (req, res) => {
			res.writeHead(200, { "content-type": "text/plain", "content-length": String(BIG_BYTES) });
			const chunk = Buffer.alloc(64 * 1024, 0x61);
			let sent = 0;
			const pump = () => {
				while (sent < BIG_BYTES) {
					sent += chunk.length;
					if (!res.write(chunk)) { res.once("drain", pump); return; }
				}
				res.end();
			};
			pump();
		},
		"/stall": (req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.write("<html><body>partial");
			stallSockets.push(res);
			// never ends
		},
		"/stall-headers": (req) => {
			stallSockets.push(req.socket);
			// never respond at all
		},
		"/r1": { status: 302, headers: { location: "/r2" } },
		"/r2": { status: 301, headers: { location: "/r3" } },
		"/r3": { status: 307, headers: { location: "/article" } },
		"/loop": { status: 302, headers: { location: "/loop" } },
		"/to-evil": { status: 302, headers: { location: "http://evil.test/" } },
		"/to-loopback": { status: 302, headers: { location: "http://localhost:9/" } },
		"/no-location": { status: 302, headers: {} },
	});
	base = server.url;
});

afterAll(async () => {
	for (const s of stallSockets) { try { s.destroy?.(); s.end?.(); } catch { /* ignore */ } }
	await server.close();
});

const local = (extra = {}) => new ReadabilityFetchProvider(() => ({ allowPrivate: true, ...extra }));

describe("plugin shape", () => {
	it("exports cordis plugin metadata and defaults", () => {
		expect(name).toBe("web-fetch-readability");
		expect(inject).toEqual(["web"]);
		expect(READABILITY_FETCH_PROVIDER_ID).toBe("readability-http");
		const cfg = new Config({});
		expect(cfg.maxOutputChars).toBe(20000);
		expect(cfg.maxBodyBytes).toBe(5242880);
		expect(cfg.timeoutMs).toBe(20000);
		expect(cfg.maxRedirects).toBe(5);
		expect(cfg.allowPrivate).toBe(false);
		expect(cfg.readability).toBe(true);
		expect(cfg.userAgent).toBe("dsh-web-fetch-readability/0.1.0");
		expect(cfg.allowedContentTypes).toContain("application/json");
		expect(cfg.pdf).toEqual({ enabled: true, maxPages: 30, maxChars: 20000 });
		expect(new Config({ pdf: { maxPages: 2 } }).pdf).toEqual({ enabled: true, maxPages: 2, maxChars: 20000 });
		expect(local().available()).toBe(true);
	});
	it("isAllowedType handles exact and wildcard entries", () => {
		expect(isAllowedType("text/html", ["text/html"])).toBe(true);
		expect(isAllowedType("text/foo", ["text/*"])).toBe(true);
		expect(isAllowedType("image/png", ["text/*", "application/json"])).toBe(false);
	});
});

describe("SSRF at the provider boundary", () => {
	it("refuses 127.0.0.1 when allowPrivate is false", async () => {
		const p = new ReadabilityFetchProvider(() => ({ allowPrivate: false }));
		const err = await p.fetch({ url: `${base}/article` }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/^Blocked URL http:\/\/127\.0\.0\.1/u);
		expect(err.message).toMatch(/allowPrivate only for local debugging/u);
	});
	it("refuses bad schemes", async () => {
		const err = await local().fetch({ url: "file:///etc/passwd" }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/scheme "file" is not allowed/u);
	});
	it("refuses a redirect to a host resolving to a private address (per-hop re-validation)", async () => {
		// Allow only the loopback fixture origin; the redirect target evil.test → 10.0.0.1 must be rejected.
		const onlyOrigin = (host) => host === "127.0.0.1";
		const seen = [];
		const lookup = fakeLookup({ "evil.test": ["10.0.0.1"] });
		const spy = async (host) => { seen.push(host); return lookup(host); };
		const err = await download(`${base}/to-evil`, { allowPrivate: onlyOrigin, lookup: spy }).catch((e) => e);
		expect(seen).toEqual(["evil.test"]);
		expect(err).toBeInstanceOf(BlockedUrlError);
		expect(err.message).toMatch(/evil\.test.*10\.0\.0\.1/u);

		const p = new ReadabilityFetchProvider(() => ({ allowPrivate: onlyOrigin, lookup: spy }));
		const werr = await p.fetch({ url: `${base}/to-evil` }).catch((e) => e);
		expect(werr.code).toBe("WEB_PROVIDER_ERROR");
		expect(werr.message).toMatch(/^Blocked URL http:\/\/evil\.test\//u);
	});
	it("refuses a redirect to localhost by the hostname rule", async () => {
		const err = await download(`${base}/to-loopback`, { allowPrivate: (h) => h === "127.0.0.1", lookup: fakeLookup() }).catch((e) => e);
		expect(err).toBeInstanceOf(BlockedUrlError);
		expect(err.message).toMatch(/localhost/u);
	});
});

describe("redirects", () => {
	it("follows a 3-hop chain and reports the final URL", async () => {
		const r = await local().fetch({ url: `${base}/r1` });
		expect(r.statusCode).toBe(200);
		expect(r.url).toBe(`${base}/article`);
		expect(r.body.kind).toBe("html");
	});
	it("fails after more than maxRedirects hops", async () => {
		const err = await local({ maxRedirects: 5 }).fetch({ url: `${base}/loop` }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/too many redirects/u);
		await expect(download(`${base}/loop`, { allowPrivate: true, maxRedirects: 5 })).rejects.toBeInstanceOf(RedirectError);
	});
	it("allows exactly maxRedirects hops", async () => {
		const r = await local({ maxRedirects: 3 }).fetch({ url: `${base}/r1` });
		expect(r.url).toBe(`${base}/article`);
		const err = await local({ maxRedirects: 2 }).fetch({ url: `${base}/r1` }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
	});
	it("rejects a redirect without Location", async () => {
		const err = await local().fetch({ url: `${base}/no-location` }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/without a Location/u);
	});
});

describe("content routing", () => {
	it("article page → kind html with <h1>, nav gone, under the cap", async () => {
		const r = await local().fetch({ url: `${base}/article` });
		expect(r.statusCode).toBe(200);
		expect(r.body.kind).toBe("html");
		expect(r.body.content.startsWith("<h1>Streaming Parsers Considered Delightful")).toBe(true);
		expect(r.body.content).toContain("FINALMARKER");
		expect(r.body.content).not.toContain("NAVMARKER_ARCHIVE");
		expect(r.body.content).not.toContain("FOOTERMARKER");
		expect(r.body.content).not.toContain("COOKIEMARKER");
		expect(r.body.content).not.toContain("Related post number");
		expect(r.truncated).toBe(false);
		expect(r.body.content.length).toBeLessThanOrEqual(20000);
		// eslint-disable-next-line no-console
		console.log(`[size] raw ${ARTICLE_HTML.length} chars → extracted ${r.body.content.length} chars (${Math.round((1 - r.body.content.length / ARTICLE_HTML.length) * 100)}% smaller)`);
	});
	it("non-article page → fallback cleaned page", async () => {
		const r = await local().fetch({ url: `${base}/index` });
		expect(r.body.kind).toBe("html");
		expect(r.body.content).toMatch(/^<h1>Index of Things<\/h1>/u);
		expect(r.body.content).toContain("Item 29");
		expect(r.body.content).not.toContain("NAVMARKER");
	});
	it("applies maxOutputChars with a trailer", async () => {
		const r = await local({ maxOutputChars: 1500 }).fetch({ url: `${base}/article` });
		expect(r.truncated).toBe(true);
		expect(r.body.content).toMatch(/\[truncated: shown \d+ of \d+ chars\]/u);
		expect(r.body.content.length).toBeLessThan(1700);
	});
	it("gb2312 page decodes correctly", async () => {
		const r = await local().fetch({ url: `${base}/gb2312` });
		expect(r.body.kind).toBe("html");
		expect(r.body.content).toContain("<h1>中文</h1>");
		expect(r.body.content).toContain("中文 GBMARKER");
	});
	it("text/plain passes as kind text", async () => {
		const r = await local().fetch({ url: `${base}/plain` });
		expect(r.body).toEqual({ kind: "text", content: "just some text\nline two" });
		expect(r.truncated).toBe(false);
	});
	it("JSON passes as kind text", async () => {
		const r = await local().fetch({ url: `${base}/json` });
		expect(r.body.kind).toBe("text");
		expect(JSON.parse(r.body.content)).toEqual({ ok: true, n: 1 });
	});
	it("application/pdf with corrupt bytes → graceful unsupported-style note", async () => {
		const r = await local().fetch({ url: `${base}/pdf` });
		expect(r.statusCode).toBe(200);
		expect(r.body.kind).toBe("text");
		expect(r.body.content).toMatch(/^Unsupported content type "application\/pdf" at http/u);
		expect(r.body.content).toMatch(/not a valid PDF/u);
		expect(r.body.content).toContain("tavily-extract");
		expect(r.truncated).toBe(false);
	});
	it("application/pdf with pdf.enabled=false → old unsupported note", async () => {
		const r = await local({ pdf: { enabled: false } }).fetch({ url: `${base}/pdf` });
		expect(r.body.content).toMatch(/^Unsupported content type "application\/pdf" at http/u);
		expect(r.body.content).toContain("web_fetch can only read HTML, text, JSON and XML.");
		expect(r.body.content).not.toContain("pdf.js");
	});
	it("image/png → unsupported note", async () => {
		const r = await local().fetch({ url: `${base}/png` });
		expect(r.body.content).toMatch(/Unsupported content type "image\/png"/u);
		expect(r.body.content).toContain("(300 bytes)");
	});
	it("404 → result with statusCode 404, never a throw", async () => {
		const r = await local().fetch({ url: `${base}/missing` });
		expect(r.statusCode).toBe(404);
		expect(r.body.kind).toBe("text");
		expect(r.body.content).toMatch(/^HTTP 404 Not Found for http/u);
		expect(r.body.content).toContain("Nothing here");
		expect(r.body.content).not.toContain("<h1>");
	});
	it("500 JSON → result with the body quoted", async () => {
		const r = await local().fetch({ url: `${base}/error` });
		expect(r.statusCode).toBe(500);
		expect(r.body.content).toContain('{"error":"boom"}');
	});
});

describe("limits", () => {
	it("8 MB body is truncated at 5 MB", async () => {
		const dl = await download(`${base}/big`, { allowPrivate: true, maxBodyBytes: CAP, timeoutMs: 20000 });
		expect(dl.truncated).toBe(true);
		expect(dl.bytes.length).toBe(CAP);
		const r = await local({ maxBodyBytes: CAP, maxOutputChars: 1000 }).fetch({ url: `${base}/big` });
		expect(r.truncated).toBe(true);
		expect(r.body.kind).toBe("text");
	}, 30000);

	it("a stalled body hits timeoutMs → WEB_PROVIDER_ERROR mentioning timed out", async () => {
		const err = await local({ timeoutMs: 100 }).fetch({ url: `${base}/stall` }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/timed out/u);
	});

	it("stalled headers hit timeoutMs too", async () => {
		const err = await local({ timeoutMs: 100 }).fetch({ url: `${base}/stall-headers` }).catch((e) => e);
		expect(err.code).toBe("WEB_PROVIDER_ERROR");
		expect(err.message).toMatch(/timed out/u);
	});

	it("caller abort → WEB_ABORTED", async () => {
		const ac = new AbortController();
		const pending = local({ timeoutMs: 5000 }).fetch({ url: `${base}/stall` }, ac.signal).catch((e) => e);
		setTimeout(() => ac.abort(new Error("user cancelled")), 30);
		const err = await pending;
		expect(err.code).toBe("WEB_ABORTED");
	});

	it("pre-aborted signal → WEB_ABORTED without touching the network", async () => {
		const ac = new AbortController();
		ac.abort();
		const err = await local().fetch({ url: `${base}/article` }, ac.signal).catch((e) => e);
		expect(err.code).toBe("WEB_ABORTED");
	});
});
