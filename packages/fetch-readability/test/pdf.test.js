import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ReadabilityFetchProvider, PDF_MEDIA_TYPES } from "../lib/index.js";
import { extractPdfText, PdfExtractError, textItemsToPage } from "../lib/pdf.js";
import { startFixtureServer } from "./fixtures.js";
import { HELLO_PDF, TWO_PAGE_PDF, makePdf } from "./pdf-fixtures.js";

const longLines = Array.from({ length: 40 }, (_, i) => `Line ${i} of a fairly long paragraph used to fill the page with text.`);
const BIG_PDF = makePdf([longLines, longLines, longLines, longLines], { title: "Big Report" });
const EMPTY_PDF = makePdf([[]]);

describe("pdf fixtures", () => {
	it("hand-built PDF is well-formed enough for pdf.js", () => {
		const s = Buffer.from(HELLO_PDF).toString("latin1");
		expect(s.startsWith("%PDF-1.4")).toBe(true);
		expect(s).toContain("Hello PDF");
		expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
		expect(HELLO_PDF.length).toBeLessThan(1200);
	});
});

describe("extractPdfText", () => {
	it("extracts text lines and the Info title", async () => {
		const r = await extractPdfText(HELLO_PDF);
		expect(r).toEqual({ text: "Hello PDF\nSecond line here", pages: 1, totalPages: 1, truncated: false, title: "Hello Title" });
	});
	it("separates pages with a blank line, no title when absent", async () => {
		const r = await extractPdfText(TWO_PAGE_PDF);
		expect(r.text).toBe("Page one text\n\nPage two text");
		expect(r.pages).toBe(2);
		expect(r.totalPages).toBe(2);
		expect(r.truncated).toBe(false);
		expect(r.title).toBeUndefined();
	});
	it("stops at maxPages and flags truncated", async () => {
		const r = await extractPdfText(TWO_PAGE_PDF, { maxPages: 1 });
		expect(r).toEqual({ text: "Page one text", pages: 1, totalPages: 2, truncated: true });
	});
	it("stops at maxChars and flags truncated", async () => {
		const r = await extractPdfText(BIG_PDF, { maxChars: 500 });
		expect(r.truncated).toBe(true);
		expect(r.text.length).toBeLessThanOrEqual(500);
		expect(r.text.startsWith("Line 0 of a fairly long")).toBe(true);
		expect(r.pages).toBe(1);
		expect(r.totalPages).toBe(4);
		expect(r.title).toBe("Big Report");
	});
	it("maxChars exactly on a page boundary does not truncate", async () => {
		const r = await extractPdfText(TWO_PAGE_PDF, { maxChars: "Page one text\n\nPage two text".length });
		expect(r.truncated).toBe(false);
	});
	it("empty text layer → empty text, not an error", async () => {
		const r = await extractPdfText(EMPTY_PDF);
		expect(r.text).toBe("");
		expect(r.pages).toBe(1);
	});
	it("corrupt bytes → PdfExtractError with a clear message", async () => {
		await expect(extractPdfText(new Uint8Array(Buffer.from("%PDF-1.4 fake")))).rejects.toBeInstanceOf(PdfExtractError);
		const err = await extractPdfText(new Uint8Array(Buffer.from("garbage"))).catch((e) => e);
		expect(err.message).toMatch(/^Could not read PDF: the file is not a valid PDF/u);
	});
	it("pre-aborted signal → AbortError", async () => {
		const ac = new AbortController();
		ac.abort();
		const err = await extractPdfText(HELLO_PDF, { signal: ac.signal }).catch((e) => e);
		expect(err.name).toBe("AbortError");
	});
	it("does not detach the caller's buffer", async () => {
		const copy = new Uint8Array(HELLO_PDF);
		await extractPdfText(copy);
		expect(copy.length).toBe(HELLO_PDF.length);
		expect(copy[0]).toBe(0x25);
	});
});

describe("textItemsToPage", () => {
	const item = (str, x, y, width = str.length * 6, hasEOL = false) => ({ str, hasEOL, width, height: 10, transform: [10, 0, 0, 10, x, y], dir: "ltr", fontName: "f" });
	it("joins same-line items, inserting a space across a gap", () => {
		const text = textItemsToPage({ items: [item("Hello", 0, 700), item("World", 60, 700), item("!", 90, 700, 6, true), item("Next", 0, 686)] });
		// "Hello" spans x 0–30, "World" starts at 60 (gap → space); "!" starts exactly where "World" ends (no space).
		expect(text).toBe("Hello World!\nNext");
	});
	it("baseline change without hasEOL starts a new line", () => {
		const text = textItemsToPage({ items: [item("A", 0, 700), item("B", 0, 680)] });
		expect(text).toBe("A\nB");
	});
	it("collapses whitespace and drops blank lines", () => {
		const text = textItemsToPage({ items: [item("  spaced   out ", 0, 700, 60, true), item("   ", 0, 686, 10, true), item("end", 0, 672)] });
		expect(text).toBe("spaced out\nend");
	});
	it("skips marked-content items", () => {
		const text = textItemsToPage({ items: [{ type: "beginMarkedContent", id: "x" }, item("ok", 0, 700)] });
		expect(text).toBe("ok");
	});
});

describe("provider routing of PDFs", () => {
	let server;
	let base;
	beforeAll(async () => {
		server = await startFixtureServer({
			"/doc.pdf": { headers: { "content-type": "application/pdf" }, body: Buffer.from(HELLO_PDF) },
			"/two": { headers: { "content-type": "application/x-pdf; charset=binary" }, body: Buffer.from(TWO_PAGE_PDF) },
			"/report.pdf": { headers: { "content-type": "application/pdf" }, body: Buffer.from(BIG_PDF) },
			"/scan.pdf": { headers: { "content-type": "application/pdf" }, body: Buffer.from(EMPTY_PDF) },
			"/broken.pdf": { headers: { "content-type": "application/pdf" }, body: Buffer.from("%PDF-1.7\nnot really") },
			"/octet": { headers: { "content-type": "application/octet-stream" }, body: Buffer.from(HELLO_PDF) },
			"/huge.pdf": (req, res) => {
				res.writeHead(200, { "content-type": "application/pdf" });
				res.end(Buffer.concat([Buffer.from(HELLO_PDF), Buffer.alloc(200 * 1024, 0x20)]));
			},
		});
		base = server.url;
	});
	afterAll(async () => { await server.close(); });
	const local = (extra = {}) => new ReadabilityFetchProvider(() => ({ allowPrivate: true, ...extra }));

	it("exports the routed media types", () => {
		expect(PDF_MEDIA_TYPES).toEqual(["application/pdf", "application/x-pdf"]);
	});
	it("application/pdf → kind text with '# <title>' header and the text", async () => {
		const r = await local().fetch({ url: `${base}/doc.pdf` });
		expect(r.statusCode).toBe(200);
		expect(r.body).toEqual({ kind: "text", content: "# Hello Title\n\nHello PDF\nSecond line here" });
		expect(r.truncated).toBe(false);
	});
	it("application/x-pdf with parameters routes too; filename used when no title", async () => {
		const r = await local().fetch({ url: `${base}/two` });
		expect(r.body.content).toBe("# two\n\nPage one text\n\nPage two text");
	});
	it("pdf.maxPages truncation is visible", async () => {
		const r = await local({ pdf: { maxPages: 1 } }).fetch({ url: `${base}/two` });
		expect(r.truncated).toBe(true);
		expect(r.body.content).toBe("# two\n\nPage one text\n[truncated: read 1 of 2 pages, 13 chars; limits pdf.maxPages=1, pdf.maxChars=20000]");
	});
	it("pdf.maxChars truncation is visible and respects the minimum", async () => {
		const r = await local({ pdf: { maxChars: 1000 } }).fetch({ url: `${base}/report.pdf` });
		expect(r.truncated).toBe(true);
		expect(r.body.content.startsWith("# Big Report\n\nLine 0 of")).toBe(true);
		expect(r.body.content).toMatch(/\[truncated: read 1 of 4 pages, \d+ chars; limits pdf.maxPages=30, pdf.maxChars=1000\]$/u);
	});
	it("maxOutputChars still caps PDF text with the standard trailer", async () => {
		const r = await local({ maxOutputChars: 1000, pdf: { maxChars: 100000 } }).fetch({ url: `${base}/report.pdf` });
		expect(r.truncated).toBe(true);
		expect(r.body.content).toMatch(/\[truncated: shown 1000 of \d+ chars\]$/u);
		expect(r.body.content).not.toContain("pdf.maxPages");
	});
	it("image-only PDF → explanatory note pointing at tavily-extract", async () => {
		const r = await local().fetch({ url: `${base}/scan.pdf` });
		expect(r.body.content).toMatch(/^# scan\n\n\(No text layer found in 1 of 1 page/u);
		expect(r.body.content).toContain("tavily-extract");
		expect(r.truncated).toBe(false);
	});
	it("broken PDF → note, never a throw", async () => {
		const r = await local().fetch({ url: `${base}/broken.pdf` });
		expect(r.statusCode).toBe(200);
		expect(r.body.content).toMatch(/^Unsupported content type "application\/pdf" at http.*not a valid PDF/u);
	});
	it("download cap hit → note instead of parsing a half file", async () => {
		const r = await local({ maxBodyBytes: 65_536 }).fetch({ url: `${base}/huge.pdf` });
		expect(r.body.content).toMatch(/larger than the download limit \(65536 bytes received/u);
		expect(r.body.content).toContain("maxBodyBytes");
	});
	it("pdf.enabled=false → unsupported note even for a valid PDF", async () => {
		const r = await local({ pdf: { enabled: false } }).fetch({ url: `${base}/doc.pdf` });
		expect(r.body.content).toMatch(/^Unsupported content type "application\/pdf"/u);
		expect(r.body.content).toContain("web_fetch can only read HTML, text, JSON and XML.");
	});
	it("pdf.enabled=false but application/pdf in allowedContentTypes → decoded as text (explicit opt-in)", async () => {
		const r = await local({ pdf: { enabled: false }, allowedContentTypes: ["application/pdf"] }).fetch({ url: `${base}/doc.pdf` });
		expect(r.body.kind).toBe("text");
		expect(r.body.content.startsWith("%PDF-1.4")).toBe(true);
	});
	it("octet-stream is not sniffed as PDF", async () => {
		const r = await local().fetch({ url: `${base}/octet` });
		expect(r.body.content).toMatch(/^Unsupported content type "application\/octet-stream"/u);
	});
	it("caller abort during extraction → WEB_ABORTED", async () => {
		const ac = new AbortController();
		const pending = local().fetch({ url: `${base}/report.pdf` }, ac.signal).catch((e) => e);
		ac.abort(new Error("stop"));
		const err = await pending;
		expect(err.code).toBe("WEB_ABORTED");
	});
});
