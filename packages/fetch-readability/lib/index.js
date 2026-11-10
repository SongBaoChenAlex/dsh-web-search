/**
 * Readability-based `web_fetch` provider for the DeepSeek Harness web seam
 * (`ctx.web`). Registers under id `readability-http`.
 *
 * Pipeline: SSRF guard → bounded download (redirects re-validated) → charset
 * decode → content-type routing → Readability / cleaned page / PDF text layer
 * (pdf.js, lazy-loaded) → output cap.
 * HTML is returned as `kind:'html'`; the official `web_fetch` tool turns it
 * into Markdown.
 *
 * @module @tobedone4byme/dsh-web-fetch-readability
 */
import z from "@deepseek-ai/schemastery";
import { isAbortError, webError, bindHost } from "@tobedone4byme/dsh-web-shared/http";
import { liveConfig } from "@tobedone4byme/dsh-web-shared/settings";
import { decodeBody } from "./decode.js";
import { download, RedirectError } from "./download.js";
import { capHtml, capText, extractArticle } from "./extract.js";
import { PdfExtractError, extractPdfText } from "./pdf.js";
import { BlockedUrlError } from "./ssrf.js";

/** Stable id this provider registers under (select it via the `web` row's `fetchProvider`). */
export const READABILITY_FETCH_PROVIDER_ID = "readability-http";

export const DEFAULT_USER_AGENT = "dsh-web-fetch-readability/0.1.0";
export const DEFAULT_ALLOWED_CONTENT_TYPES = [
	"text/html",
	"application/xhtml+xml",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
	"application/xml",
	"text/xml",
	"application/ld+json",
];

export const DEFAULTS = Object.freeze({
	maxOutputChars: 20_000,
	maxBodyBytes: 5_242_880,
	timeoutMs: 20_000,
	maxRedirects: 5,
	userAgent: DEFAULT_USER_AGENT,
	acceptLanguage: "en-US,en;q=0.8",
	allowPrivate: false,
	readability: true,
	allowedContentTypes: DEFAULT_ALLOWED_CONTENT_TYPES,
	pdf: Object.freeze({ enabled: true, maxPages: 30, maxChars: 20_000 }),
});

/** Media types routed to the PDF text extractor. */
export const PDF_MEDIA_TYPES = ["application/pdf", "application/x-pdf"];

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-fetch-readability";
/** The web seam this provider registers into. */
export const inject = ["web"];

export const PdfConfig = z.object({
	enabled: z.boolean().default(DEFAULTS.pdf.enabled).description("Extract the text layer of application/pdf responses (pdf.js). false → PDFs yield the 'unsupported content type' note."),
	maxPages: z.number().step(1).min(1).default(DEFAULTS.pdf.maxPages).description("Pages read from the start of the document; the rest is skipped and the result is flagged truncated."),
	maxChars: z.number().step(1).min(1000).default(DEFAULTS.pdf.maxChars).description("Cap on the extracted PDF text in characters (defaults to the same value as maxOutputChars)."),
});

export const Config = z.object({
	maxOutputChars: z.number().step(1).min(1000).default(DEFAULTS.maxOutputChars).description("Cap on the returned body in characters; a visible [truncated] trailer is appended."),
	maxBodyBytes: z.number().step(1).min(65_536).default(DEFAULTS.maxBodyBytes).description("Download ceiling in bytes; the stream is cancelled beyond it."),
	timeoutMs: z.number().step(1).min(1000).default(DEFAULTS.timeoutMs).description("Budget for the whole request (all redirect hops + body)."),
	maxRedirects: z.number().step(1).min(0).max(20).default(DEFAULTS.maxRedirects),
	userAgent: z.string().default(DEFAULTS.userAgent),
	acceptLanguage: z.string().default(DEFAULTS.acceptLanguage),
	allowPrivate: z.boolean().default(DEFAULTS.allowPrivate).description("DEBUG ONLY: permit loopback / private / link-local targets."),
	readability: z.boolean().default(DEFAULTS.readability).description("false → always return the cleaned full page."),
	allowedContentTypes: z.array(z.string()).default([...DEFAULT_ALLOWED_CONTENT_TYPES]),
	pdf: PdfConfig.default({ ...DEFAULTS.pdf }).description("PDF text extraction."),
});

export const SETTINGS_NAMESPACE = "web-fetch-readability";

/**
 * Lower-cased media type without parameters.
 * @param {string} contentType
 */
export function mediaTypeOf(contentType) {
	return String(contentType ?? "").split(";")[0].trim().toLowerCase();
}

function isHtml(mediaType) {
	return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

/** Textual enough to quote the first few hundred chars of an error page. */
function isTextual(mediaType) {
	return mediaType.startsWith("text/") || /[/+](json|xml)$/u.test(mediaType) || mediaType === "";
}

/**
 * @param {string} mediaType
 * @param {string[]} allowed  entries may be exact (`text/html`) or wildcard (`text/*`).
 */
export function isAllowedType(mediaType, allowed) {
	for (const entry of allowed) {
		const e = entry.trim().toLowerCase();
		if (e === "*/*" || e === mediaType) return true;
		if (e.endsWith("/*") && mediaType.startsWith(e.slice(0, -1))) return true;
	}
	return false;
}

/**
 * The Readability fetch provider.
 * @implements {import('@deepseek-ai/dsh-web').WebFetchProvider}
 */
export class ReadabilityFetchProvider {
	id = READABILITY_FETCH_PROVIDER_ID;

	/**
	 * @param {() => Partial<typeof DEFAULTS> & { lookup?: (host: string) => Promise<string[]> }} [resolveOptions]
	 *   thunk resolved once per fetch so settings changes never mix mid-flight.
	 */
	constructor(resolveOptions = () => ({})) {
		this.resolveOptions = resolveOptions;
	}

	available() {
		return true;
	}

	/**
	 * @param {{ url: string }} request
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<import('@deepseek-ai/dsh-web').WebFetchResult>}
	 */
	async fetch(request, signal) {
		const options = { ...DEFAULTS, ...stripUndefined(this.resolveOptions()) };
		const requested = String(request?.url ?? "").trim();
		if (signal?.aborted === true) throw await aborted(signal);

		let dl;
		try {
			dl = await download(requested, {
				maxBodyBytes: options.maxBodyBytes,
				timeoutMs: options.timeoutMs,
				maxRedirects: options.maxRedirects,
				userAgent: options.userAgent,
				acceptLanguage: options.acceptLanguage,
				allowPrivate: options.allowPrivate,
				...options.lookup ? { lookup: options.lookup } : {},
			}, signal);
		} catch (error) {
			throw await mapDownloadError(error, requested, signal);
		}

		const mediaType = mediaTypeOf(dl.contentType);
		const { finalUrl, statusCode } = dl;

		if (statusCode < 200 || statusCode >= 300) {
			let content = `HTTP ${statusCode}${dl.statusText ? ` ${dl.statusText}` : ""} for ${finalUrl}`;
			if (isTextual(mediaType) && dl.bytes.length > 0) {
				let snippet = decodeBody(dl.bytes, dl.contentType);
				if (isHtml(mediaType)) snippet = htmlToRoughText(snippet);
				snippet = snippet.replace(/\s+/gu, " ").trim().slice(0, 500);
				if (snippet.length > 0) content += `\n\n${snippet}`;
			}
			return { url: finalUrl, statusCode, body: { kind: "text", content }, truncated: false };
		}

		const pdfOptions = { ...DEFAULTS.pdf, ...stripUndefined(options.pdf) };
		const isPdf = PDF_MEDIA_TYPES.includes(mediaType);
		const allowed = isAllowedType(mediaType, options.allowedContentTypes) || (isPdf && pdfOptions.enabled);

		if (!allowed) {
			const label = mediaType.length > 0 ? mediaType : "unknown";
			return {
				url: finalUrl,
				statusCode,
				body: { kind: "text", content: `Unsupported content type "${label}" at ${finalUrl} (${dl.bytes.length}${dl.truncated ? "+" : ""} bytes). web_fetch can only read HTML, text, JSON and XML.` },
				truncated: false,
			};
		}

		if (isPdf && pdfOptions.enabled) {
			return this.#fetchPdf(dl, { finalUrl, statusCode, pdfOptions, maxOutputChars: options.maxOutputChars }, signal);
		}

		const text = decodeBody(dl.bytes, dl.contentType);

		if (isHtml(mediaType)) {
			const article = extractArticle(text, { url: finalUrl, readability: options.readability });
			const capped = capHtml(article.html, options.maxOutputChars);
			return {
				url: finalUrl,
				statusCode,
				body: { kind: "html", content: capped.html },
				truncated: capped.truncated || dl.truncated,
			};
		}

		const capped = capText(text, options.maxOutputChars);
		return {
			url: finalUrl,
			statusCode,
			body: { kind: "text", content: capped.text },
			truncated: capped.truncated || dl.truncated,
		};
	}

	/**
	 * PDF branch: hand the complete download to pdf.js and return Markdown-ish
	 * text. Never throws for a bad file — the model gets an explanatory note.
	 * @param {Awaited<ReturnType<typeof download>>} dl
	 * @param {{ finalUrl: string, statusCode: number, pdfOptions: typeof DEFAULTS.pdf, maxOutputChars: number }} ctx
	 * @param {AbortSignal | undefined} signal
	 * @returns {Promise<import('@deepseek-ai/dsh-web').WebFetchResult>}
	 */
	async #fetchPdf(dl, { finalUrl, statusCode, pdfOptions, maxOutputChars }, signal) {
		const note = (content) => ({ url: finalUrl, statusCode, body: { kind: "text", content }, truncated: false });
		if (dl.truncated) {
			return note(`PDF at ${finalUrl} is larger than the download limit (${dl.bytes.length} bytes received, more available); a partial PDF cannot be parsed. Raise maxBodyBytes or use another extractor (e.g. tavily-extract).`);
		}
		let result;
		try {
			result = await extractPdfText(dl.bytes, { maxPages: pdfOptions.maxPages, maxChars: pdfOptions.maxChars, signal });
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw await aborted(signal, error);
			const detail = error instanceof PdfExtractError ? error.message : `pdf.js failed: ${error?.message ?? error}`;
			return note(`Unsupported content type "application/pdf" at ${finalUrl} (${dl.bytes.length} bytes): ${detail}. web_fetch could not extract text from this PDF; try another extractor (e.g. tavily-extract).`);
		}
		const title = result.title ?? filenameOf(finalUrl) ?? "PDF document";
		const header = `# ${title}\n\n`;
		if (result.text.length === 0) {
			return note(`${header}(No text layer found in ${result.pages} of ${result.totalPages} page${result.totalPages === 1 ? "" : "s"} — the PDF is probably scanned or image-only. Use an OCR-capable extractor such as tavily-extract.)`);
		}
		const capped = capText(result.text, maxOutputChars);
		let content = header + capped.text;
		if (result.truncated && !capped.truncated) {
			content += `\n[truncated: read ${result.pages} of ${result.totalPages} pages, ${result.text.length} chars; limits pdf.maxPages=${pdfOptions.maxPages}, pdf.maxChars=${pdfOptions.maxChars}]`;
		}
		return { url: finalUrl, statusCode, body: { kind: "text", content }, truncated: result.truncated || capped.truncated };
	}
}

/**
 * Last path segment of a URL, decoded, without a `.pdf` extension; `undefined` when blank.
 * @param {string} url
 */
function filenameOf(url) {
	try {
		const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
		const name = decodeURIComponent(seg).replace(/\.pdf$/iu, "").trim();
		return name.length > 0 ? name : undefined;
	} catch {
		return undefined;
	}
}

function stripUndefined(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v;
	return out;
}

/** Cheap tag strip for quoting error pages (no DOM needed). */
function htmlToRoughText(html) {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ")
		.replace(/<[^>]+>/gu, " ")
		.replace(/&nbsp;/gu, " ")
		.replace(/&amp;/gu, "&")
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">");
}

async function aborted(signal, cause) {
	return webError("web_fetch aborted", "WEB_ABORTED", signal?.aborted === true ? signal.reason : cause);
}

/**
 * Translate downloader failures into the seam's `WebError` codes.
 * @param {unknown} error
 * @param {string} url
 * @param {AbortSignal | undefined} signal
 */
async function mapDownloadError(error, url, signal) {
	if (signal?.aborted === true) return aborted(signal, error);
	if (error instanceof BlockedUrlError) {
		return webError(`Blocked URL ${error.url}: ${error.reason} (private, loopback and link-local targets are refused; set allowPrivate only for local debugging)`, "WEB_PROVIDER_ERROR", error);
	}
	if (error instanceof RedirectError) {
		return webError(`Redirect limit exceeded or invalid redirect: ${error.message}`, "WEB_PROVIDER_ERROR", error);
	}
	if (error?.name === "TimeoutError") {
		return webError(`web_fetch of ${url} timed out: ${error.message}`, "WEB_PROVIDER_ERROR", error);
	}
	if (isAbortError(error)) return aborted(signal, error);
	if (error?.code !== undefined && typeof error.message === "string" && /^WEB_/u.test(error.code)) return error;
	const detail = error?.cause?.message ?? error?.message ?? String(error);
	return webError(`web_fetch of ${url} failed: ${detail}`, "WEB_PROVIDER_ERROR", error);
}

/**
 * Register the provider with `ctx.web`; config is hot-reloadable through the
 * `web-fetch-readability:` section of `~/.dsh/settings.yaml`.
 */
export function apply(ctx, config) {
	void bindHost(ctx); // make thrown errors genuine dsh-web WebError instances
	const current = liveConfig(ctx, SETTINGS_NAMESPACE, Config, config);
	ctx.web.registerFetchProvider(new ReadabilityFetchProvider(() => current()));
}
