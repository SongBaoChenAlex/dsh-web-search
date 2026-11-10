import { describe, it, expect } from "vitest";
import { decodeBody, detectCharset, charsetFromContentType } from "../lib/decode.js";
import { capHtml, capText, extractArticle } from "../lib/extract.js";
import { ARTICLE_HTML, GB2312_BYTES, NON_ARTICLE_HTML } from "./fixtures.js";

describe("decodeBody", () => {
	it("prefers the header charset", () => {
		expect(charsetFromContentType('text/html; charset="ISO-8859-1"')).toBe("windows-1252");
		const bytes = Buffer.from([0xe9]); // é in latin1
		expect(decodeBody(bytes, "text/plain; charset=iso-8859-1")).toBe("é");
	});
	it("uses the BOM over everything", () => {
		const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo", "utf8")]);
		expect(detectCharset(bytes, "text/plain; charset=gbk")).toBe("utf-8");
		expect(decodeBody(bytes, "text/plain; charset=gbk")).toBe("héllo");
	});
	it("sniffs <meta http-equiv> gb2312 and decodes 中文", () => {
		expect(detectCharset(GB2312_BYTES, "text/html")).toBe("gbk");
		const text = decodeBody(GB2312_BYTES, "text/html");
		expect(text).toContain("<title>中文</title>");
		expect(text).toContain("中文 GBMARKER");
	});
	it("sniffs <meta charset>", () => {
		const bytes = Buffer.concat([Buffer.from('<html><head><meta charset="big5"></head><body>', "latin1"), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), Buffer.from("</body></html>", "latin1")]);
		expect(decodeBody(bytes, "text/html")).toContain("中文");
	});
	it("falls back to utf-8 for unknown charsets", () => {
		expect(decodeBody(Buffer.from("ok ✓", "utf8"), "text/plain; charset=x-nonsense-9")).toBe("ok ✓");
	});
	it("supports the common CJK / legacy encodings at runtime", () => {
		for (const enc of ["gbk", "gb18030", "big5", "shift_jis", "euc-kr", "windows-1252", "utf-16le"]) {
			expect(() => new TextDecoder(enc)).not.toThrow();
		}
	});
});

describe("extractArticle", () => {
	it("extracts the article with Readability: <h1>, body kept, chrome dropped", () => {
		const r = extractArticle(ARTICLE_HTML, { url: "https://example.com/post" });
		expect(r.method).toBe("readability");
		expect(r.title).toMatch(/Streaming Parsers Considered Delightful/u);
		expect(r.html.startsWith("<h1>")).toBe(true);
		expect(r.html).toContain("Paragraph 14.");
		expect(r.html).toContain("FINALMARKER");
		expect(r.html).not.toContain("NAVMARKER_ARCHIVE");
		expect(r.html).not.toContain("SIDEBARMARKER");
		expect(r.html).not.toContain("FOOTERMARKER");
		expect(r.html).not.toContain("<script");
		expect(r.html).not.toContain("<style");
		expect(r.html.length).toBeLessThan(ARTICLE_HTML.length);
		// Only one <h1> heading for the title.
		expect(r.html.match(/<h1/gu).length).toBe(1);
	});

	it("falls back to the cleaned page for non-article HTML", () => {
		const r = extractArticle(NON_ARTICLE_HTML, { url: "https://example.com/" });
		expect(r.method).toBe("fallback");
		expect(r.html).toMatch(/^<h1>Index of Things<\/h1>/u);
		expect(r.html).toContain("Item 29");
		expect(r.html).not.toContain("NAVMARKER");
		expect(r.html).not.toContain("FOOTERMARKER");
		expect(r.html).not.toContain("<script");
	});

	it("readability:false forces the fallback path", () => {
		const r = extractArticle(ARTICLE_HTML, { url: "https://example.com/post", readability: false });
		expect(r.method).toBe("fallback");
		expect(r.html).toContain("Paragraph 1.");
		expect(r.html).not.toContain("NAVMARKER_ARCHIVE");
		expect(r.html).not.toContain("<script");
	});

	it("escapes the title and survives a document without <body>", () => {
		const r = extractArticle("<title>a <b> & c</title><p>x</p>", { readability: false });
		expect(r.html.startsWith("<h1>a &lt;b&gt; &amp; c</h1>")).toBe(true);
		expect(r.html).toContain("<p>x</p>");
	});
});

describe("capHtml / capText", () => {
	it("passes short html through", () => {
		expect(capHtml("<p>hi</p>", 100)).toEqual({ html: "<p>hi</p>", truncated: false, total: 9 });
	});
	it("cuts at a tag boundary and appends a trailer", () => {
		const html = "<p>one</p><p>two</p><p>three</p>";
		const r = capHtml(html, 24); // inside "<p>three"
		expect(r.truncated).toBe(true);
		expect(r.total).toBe(html.length);
		expect(r.html.startsWith("<p>one</p><p>two</p>")).toBe(true);
		expect(r.html).toMatch(/<p><em>\[truncated: shown \d+ of \d+ chars\]<\/em><\/p>$/u);
		expect(r.html).not.toContain("<p>three");
	});
	it("caps plain text with a plain trailer", () => {
		const r = capText("abcdefghij", 4);
		expect(r).toEqual({ text: "abcd\n[truncated: shown 4 of 10 chars]", truncated: true, total: 10 });
	});
});
