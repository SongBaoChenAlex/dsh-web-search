/**
 * Bounded downloader: manual redirect loop with per-hop SSRF re-validation,
 * timeout, and a streamed byte cap.
 * @module @baoson/dsh-web-fetch-readability/download
 */
import { fetchWithTimeout, isAbortError, throwIfAborted } from "@baoson/dsh-web-shared/http";
import { assertSafeUrl } from "./ssrf.js";

export const DEFAULT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/*;q=0.8,application/json;q=0.8,*/*;q=0.5";

/** Thrown for too many redirects / malformed redirect targets. Provider maps to WEB_PROVIDER_ERROR. */
export class RedirectError extends Error {
	constructor(message) {
		super(message);
		this.name = "RedirectError";
	}
}

/**
 * @typedef {object} DownloadOptions
 * @property {number} [maxBodyBytes=5242880]
 * @property {number} [timeoutMs=20000]  budget for the whole hop chain + body read.
 * @property {number} [maxRedirects=5]
 * @property {string} [userAgent]
 * @property {string} [acceptLanguage]
 * @property {boolean} [allowPrivate=false]
 * @property {(host: string) => Promise<string[]>} [lookup]  injectable DNS resolver (tests).
 */

/**
 * @typedef {object} DownloadResult
 * @property {string} finalUrl
 * @property {number} statusCode
 * @property {string} statusText
 * @property {Headers} headers
 * @property {Uint8Array} bytes
 * @property {boolean} truncated
 * @property {string} contentType  raw `content-type` header value ('' when absent).
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Read a response body up to `maxBytes`, cancelling the reader when the cap is passed.
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ bytes: Uint8Array, truncated: boolean }>}
 */
async function readCapped(response, maxBytes, signal) {
	if (response.body === null) return { bytes: new Uint8Array(0), truncated: false };
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	let truncated = false;
	const read = () => abortableRead(reader, signal);
	try {
		for (;;) {
			const { done, value } = await read();
			if (done) break;
			if (value === undefined || value.length === 0) continue;
			const room = maxBytes - total;
			if (value.length > room) {
				if (room > 0) chunks.push(value.subarray(0, room));
				total += Math.max(room, 0);
				truncated = true;
				break;
			}
			chunks.push(value);
			total += value.length;
			if (total === maxBytes) {
				// Exactly at the cap: only truncated when more bytes follow.
				const next = await read();
				truncated = !next.done && (next.value?.length ?? 0) > 0;
				break;
			}
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return { bytes: out, truncated };
}

/**
 * `reader.read()` raced against `signal` so a stalled body cannot hang past the deadline.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal | undefined} signal
 */
function abortableRead(reader, signal) {
	throwIfAborted(signal, "download");
	const pending = reader.read();
	if (signal === undefined) return pending;
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			const err = new Error("download aborted", { cause: signal.reason });
			err.name = "AbortError";
			reject(err);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
			(e) => { signal.removeEventListener("abort", onAbort); reject(e); },
		);
	});
}

/**
 * Download `url` following up to `maxRedirects` redirects (each hop SSRF-checked).
 * Non-2xx responses are returned, not thrown. Throws `BlockedUrlError`,
 * `RedirectError`, `TimeoutError` (from shared/http) or an `AbortError`.
 *
 * @param {string} url
 * @param {DownloadOptions} [opts]
 * @param {AbortSignal} [signal]
 * @returns {Promise<DownloadResult>}
 */
export async function download(url, opts = {}, signal) {
	const {
		maxBodyBytes = 5_242_880,
		timeoutMs = 20_000,
		maxRedirects = 5,
		userAgent = "dsh-web-fetch-readability/0.1.0",
		acceptLanguage = "en-US,en;q=0.8",
		allowPrivate = false,
		lookup,
	} = opts;
	const headers = {
		"user-agent": userAgent,
		"accept": DEFAULT_ACCEPT,
		"accept-language": acceptLanguage,
	};
	const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
	const remaining = () => (deadline === Infinity ? 0 : Math.max(1, deadline - Date.now()));

	let current = url;
	for (let hop = 0; ; hop++) {
		throwIfAborted(signal, "download");
		const { url: safe } = await assertSafeUrl(current, { allowPrivate, ...lookup ? { lookup } : {} });
		const response = await fetchWithTimeout(safe, { method: "GET", redirect: "manual", headers }, { timeoutMs: remaining(), signal });

		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => {});
			if (location === null || location.length === 0) {
				throw new RedirectError(`HTTP ${response.status} from ${safe.href} without a Location header`);
			}
			if (hop >= maxRedirects) {
				throw new RedirectError(`too many redirects (more than ${maxRedirects}) starting from ${url}`);
			}
			let next;
			try {
				next = new URL(location, safe).href;
			} catch {
				throw new RedirectError(`invalid redirect target "${location}" from ${safe.href}`);
			}
			current = next;
			continue;
		}

		const contentType = response.headers.get("content-type") ?? "";
		const declared = Number(response.headers.get("content-length"));
		let result;
		try {
			result = await readCapped(response, maxBodyBytes, signalWithDeadline(signal, remaining()));
		} catch (error) {
			if (isAbortError(error) && signal?.aborted !== true) {
				const err = new Error(`request to ${safe.href} timed out after ${timeoutMs} ms while reading the body`, { cause: error });
				err.name = "TimeoutError";
				throw err;
			}
			throw error;
		}
		return {
			finalUrl: safe.href,
			statusCode: response.status,
			statusText: response.statusText,
			headers: response.headers,
			bytes: result.bytes,
			truncated: result.truncated || (Number.isFinite(declared) && declared > maxBodyBytes && result.bytes.length >= maxBodyBytes),
			contentType,
		};
	}
}

/**
 * Body reads happen after `fetchWithTimeout` resolved (its timer is cleared),
 * so give the read loop its own deadline-bound signal.
 * @param {AbortSignal | undefined} signal
 * @param {number} ms  0 = no timeout
 */
function signalWithDeadline(signal, ms) {
	if (ms <= 0) return signal;
	const timeout = AbortSignal.timeout(ms);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
