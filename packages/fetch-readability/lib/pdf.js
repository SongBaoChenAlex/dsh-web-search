/**
 * PDF → plain text via pdf.js (`pdfjs-dist`, legacy Node build). The library
 * is imported lazily so startup stays cheap for the common HTML path.
 * @module @tobedone4byme/dsh-web-fetch-readability/pdf
 */

/** @type {Promise<typeof import('pdfjs-dist')> | undefined} */
let pdfjsPromise;

/**
 * Lazy-load pdf.js. In Node the legacy build disables the real Worker and
 * drives `pdf.worker.mjs` in-process ("fake worker"); no canvas is needed for
 * text extraction.
 */
async function loadPdfjs() {
	pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").catch((error) => {
		pdfjsPromise = undefined;
		throw error;
	});
	return pdfjsPromise;
}

/** Thrown for unreadable (corrupt, encrypted, truncated) PDFs. */
export class PdfExtractError extends Error {
	/**
	 * @param {string} message
	 * @param {unknown} [cause]
	 */
	constructor(message, cause) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PdfExtractError";
	}
}

/**
 * Describe a pdf.js failure in plain words.
 * @param {unknown} error
 */
function describePdfError(error) {
	const name = /** @type {any} */ (error)?.name ?? "";
	const msg = /** @type {any} */ (error)?.message ?? String(error);
	if (name === "PasswordException") return "the PDF is password-protected (encrypted)";
	if (name === "InvalidPDFException") return `the file is not a valid PDF (${msg})`;
	if (name === "MissingPDFException") return "the PDF data is missing";
	if (name === "UnexpectedResponseException") return `unexpected response (${msg})`;
	return `pdf.js failed: ${msg}`;
}

/**
 * Join text items of one page into lines. pdf.js marks line ends with
 * `hasEOL`; items that sit on the same baseline but are separated by a
 * horizontal gap wider than ~a space get a space inserted.
 * @param {import('pdfjs-dist/types/src/display/api').TextContent} content
 * @returns {string}
 */
export function textItemsToPage(content) {
	const lines = [];
	let line = "";
	let prev;
	for (const raw of content.items) {
		if (!("str" in raw)) continue; // TextMarkedContent
		const item = raw;
		if (prev !== undefined && !prev.hasEOL) {
			// Same line: detect a horizontal gap between the previous item's end and this one's start.
			const prevEnd = prev.transform[4] + prev.width;
			const gap = item.transform[4] - prevEnd;
			const fontSize = Math.abs(prev.transform[0]) || Math.abs(prev.transform[3]) || Math.hypot(prev.transform[0], prev.transform[1]) || 10;
			const sameBaseline = Math.abs(item.transform[5] - prev.transform[5]) < fontSize * 0.5;
			if (!sameBaseline) {
				lines.push(line);
				line = "";
			} else if (gap > fontSize * 0.2 && line.length > 0 && !/\s$/u.test(line) && !/^\s/u.test(item.str)) {
				line += " ";
			}
		}
		line += item.str;
		if (item.hasEOL) {
			lines.push(line);
			line = "";
		}
		prev = item;
	}
	if (line.length > 0) lines.push(line);
	return lines
		.map((l) => l.replace(/[ \t\u00A0]+/gu, " ").trim())
		.filter((l) => l.length > 0)
		.join("\n");
}

/**
 * @typedef {object} PdfTextResult
 * @property {string} text          pages separated by a blank line.
 * @property {number} pages         number of pages actually read.
 * @property {number} totalPages    page count of the document.
 * @property {boolean} truncated    stopped at `maxPages` or `maxChars`.
 * @property {string} [title]       `Info.Title` or XMP `dc:title` when present.
 */

/**
 * Extract the text layer of a PDF.
 *
 * @param {Uint8Array} bytes
 * @param {{ maxPages?: number, maxChars?: number, signal?: AbortSignal }} [options]
 *   `maxPages`/`maxChars` `<= 0` means unlimited.
 * @returns {Promise<PdfTextResult>}
 * @throws {PdfExtractError} corrupt / encrypted / unparseable input.
 */
export async function extractPdfText(bytes, options = {}) {
	const { maxPages = 0, maxChars = 0, signal } = options;
	throwIfAborted(signal);

	let pdfjs;
	try {
		pdfjs = await loadPdfjs();
	} catch (error) {
		throw new PdfExtractError(`pdfjs-dist could not be loaded: ${/** @type {any} */ (error)?.message ?? error}`, error);
	}

	// pdf.js transfers (and may detach) the buffer it is given, so hand it a copy.
	const data = new Uint8Array(bytes);
	const task = pdfjs.getDocument({
		data,
		isEvalSupported: false,
		disableAutoFetch: true,
		stopAtErrors: false,
		useSystemFonts: false,
		verbosity: 0, // errors only
	});
	const onAbort = () => { task.destroy().catch(() => {}); };
	signal?.addEventListener("abort", onAbort, { once: true });

	let doc;
	try {
		try {
			doc = await task.promise;
		} catch (error) {
			throwIfAborted(signal, error);
			throw new PdfExtractError(`Could not read PDF: ${describePdfError(error)}`, error);
		}

		const totalPages = doc.numPages;
		const limitPages = maxPages > 0 ? Math.min(maxPages, totalPages) : totalPages;
		let title;
		try {
			const meta = await doc.getMetadata();
			const infoTitle = /** @type {any} */ (meta.info)?.Title;
			const xmpTitle = meta.metadata?.get("dc:title");
			title = cleanTitle(typeof infoTitle === "string" ? infoTitle : Array.isArray(xmpTitle) ? xmpTitle[0] : xmpTitle);
		} catch {
			// metadata is optional
		}

		const chunks = [];
		let length = 0;
		let pagesRead = 0;
		let truncated = false;
		for (let n = 1; n <= limitPages; n++) {
			throwIfAborted(signal);
			let pageText;
			try {
				const page = await doc.getPage(n);
				const content = await page.getTextContent();
				pageText = textItemsToPage(content);
				page.cleanup();
			} catch (error) {
				throwIfAborted(signal, error);
				pageText = ""; // a single broken page should not kill the whole document
			}
			pagesRead = n;
			if (pageText.length === 0) continue;
			const sep = chunks.length > 0 ? 2 : 0;
			if (maxChars > 0 && length + sep + pageText.length > maxChars) {
				const room = maxChars - length - sep;
				if (room > 0) chunks.push(pageText.slice(0, room));
				truncated = true;
				break;
			}
			chunks.push(pageText);
			length += sep + pageText.length;
		}
		if (pagesRead < totalPages) truncated = true;

		return { text: chunks.join("\n\n"), pages: pagesRead, totalPages, truncated, ...title !== undefined ? { title } : {} };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await task.destroy().catch(() => {}); // also tears down the document and its fake worker
	}
}

function cleanTitle(title) {
	const t = String(title ?? "").replace(/\s+/gu, " ").trim();
	return t.length > 0 ? t : undefined;
}

/**
 * @param {AbortSignal | undefined} signal
 * @param {unknown} [cause]
 */
function throwIfAborted(signal, cause) {
	if (signal?.aborted !== true) return;
	const err = new Error("PDF extraction aborted", cause === undefined ? undefined : { cause });
	err.name = "AbortError";
	throw err;
}
