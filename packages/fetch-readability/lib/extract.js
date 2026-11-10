/**
 * HTML → compact article HTML. Readability (over linkedom) when the page looks
 * like an article, otherwise a cleaned full page. Plus `capHtml` for the
 * output budget.
 * @module @tobedone4byme/dsh-web-fetch-readability/extract
 */
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** Elements dropped by the fallback cleaner (chrome, scripts, non-content). */
export const FALLBACK_REMOVE_SELECTOR = [
	"script", "style", "noscript", "template", "iframe", "svg", "canvas",
	"nav", "footer", "aside", "form",
	"[role=navigation]", "[role=banner]", "[role=contentinfo]", "[aria-hidden=true]",
].join(", ");

/** Minimal HTML escape for text placed inside element content. */
export function escapeHtml(text) {
	return String(text ?? "")
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;");
}

/**
 * Whitespace-normalize a title; `undefined` when blank.
 * @param {string | null | undefined} title
 */
function cleanTitle(title) {
	const t = String(title ?? "").replace(/\s+/gu, " ").trim();
	return t.length > 0 ? t : undefined;
}

/**
 * @param {string} html
 * @param {string | undefined} url  used by Readability to absolutize links.
 */
function parse(html, url) {
	const { document } = parseHTML(html);
	// Readability reads `documentURI` / `baseURI` to resolve relative URLs; linkedom leaves them blank.
	if (url !== undefined) {
		try {
			Object.defineProperty(document, "documentURI", { value: url, configurable: true });
			Object.defineProperty(document, "baseURI", { value: url, configurable: true });
		} catch {
			// ignore — links simply stay relative
		}
	}
	return document;
}

/**
 * Try Readability on an already-parsed document (which Readability mutates).
 * @returns {{ title: string | undefined, content: string } | undefined}
 */
function tryReadability(document) {
	try {
		if (!isProbablyReaderable(document)) return undefined;
		const article = new Readability(document, { keepClasses: false }).parse();
		if (!article || typeof article.content !== "string") return undefined;
		const text = (article.textContent ?? "").trim();
		if (text.length < 140) return undefined; // too thin to trust — fall back to the full page
		return { title: cleanTitle(article.title), content: article.content };
	} catch {
		return undefined;
	}
}

/**
 * Fallback: strip chrome and return the body.
 * @returns {{ title: string | undefined, content: string }}
 */
function cleanFullPage(document) {
	const title = cleanTitle(document.querySelector("title")?.textContent);
	for (const el of Array.from(document.querySelectorAll(FALLBACK_REMOVE_SELECTOR))) el.remove();
	const body = document.body ?? document.querySelector("body");
	let content = body ? body.innerHTML : "";
	if (content.trim().length === 0) {
		// linkedom does not synthesize <html>/<body> for fragment-like markup; serialize everything instead.
		for (const el of Array.from(document.querySelectorAll("title, head, meta, link, base"))) el.remove();
		content = Array.from(document.childNodes, (n) => n.toString()).join("");
	}
	return { title, content };
}

/**
 * @param {string} html
 * @param {{ url?: string, readability?: boolean }} [options]
 * @returns {{ html: string, title: string | undefined, method: 'readability' | 'fallback' }}
 */
export function extractArticle(html, options = {}) {
	const { url, readability = true } = options;
	let result;
	let method = "fallback";
	if (readability) {
		// Readability mutates the DOM, so give the fallback a fresh parse if it fails.
		result = tryReadability(parse(html, url));
		if (result !== undefined) method = "readability";
	}
	if (result === undefined) result = cleanFullPage(parse(html, url));
	const heading = result.title !== undefined ? `<h1>${escapeHtml(result.title)}</h1>\n` : "";
	let body = result.content.trim();
	// Avoid a duplicated headline when Readability already kept the <h1>.
	if (result.title !== undefined && new RegExp(`^<h1[^>]*>\\s*${escapeRegExp(escapeHtml(result.title))}\\s*</h1>`, "iu").test(body)) {
		body = body.replace(/^<h1[^>]*>[\s\S]*?<\/h1>\s*/iu, "");
	}
	return { html: heading + body, title: result.title, method };
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Cap HTML at `maxChars`, cutting at the last tag boundary (`>`) before the limit
 * when that does not throw away too much, and appending a visible trailer.
 * @param {string} html
 * @param {number} maxChars  `<= 0` disables the cap.
 * @returns {{ html: string, truncated: boolean, total: number }}
 */
export function capHtml(html, maxChars) {
	const total = html.length;
	if (maxChars <= 0 || total <= maxChars) return { html, truncated: false, total };
	let cut = html.slice(0, maxChars);
	const lastClose = cut.lastIndexOf(">");
	if (lastClose > maxChars * 0.8) cut = cut.slice(0, lastClose + 1);
	else {
		// Do not leave a half-open tag behind.
		const lastOpen = cut.lastIndexOf("<");
		if (lastOpen > lastClose) cut = cut.slice(0, lastOpen);
	}
	const shown = cut.length;
	return {
		html: `${cut}\n<p><em>[truncated: shown ${shown} of ${total} chars]</em></p>`,
		truncated: true,
		total,
	};
}

/**
 * Cap plain text with a plain-text trailer.
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean, total: number }}
 */
export function capText(text, maxChars) {
	const total = text.length;
	if (maxChars <= 0 || total <= maxChars) return { text, truncated: false, total };
	const cut = text.slice(0, maxChars);
	return { text: `${cut}\n[truncated: shown ${cut.length} of ${total} chars]`, truncated: true, total };
}
