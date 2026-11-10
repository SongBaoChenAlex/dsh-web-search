/**
 * HTTP + abort helpers. `WebError` is imported lazily so this module also loads
 * in unit tests without the DSH runtime installed.
 * @module @baoson/dsh-web-shared/http
 */

import { importHost } from "./host.js";

/** Same public shape as dsh-web's WebError (message, code, cause); used only outside a DSH process. */
class FallbackWebError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.name = "WebError";
		this.code = code;
	}
}

let WebErrorCtor;
/**
 * Resolve the real `WebError` class from the host. Plugins should call
 * {@link bindHost} once in `apply(ctx)` so later `webError()` calls (which have
 * no ctx) produce genuine `dsh-web` instances; without it, the fallback class is used.
 */
export async function bindHost(ctx) {
	const mod = await importHost(ctx, "@deepseek-ai/dsh-web");
	if (mod?.WebError) WebErrorCtor = mod.WebError;
	return WebErrorCtor ?? FallbackWebError;
}

/** Build a WebError with the given code. Always `await` this. */
export async function webError(message, code, cause) {
	const Ctor = WebErrorCtor ?? FallbackWebError;
	return new Ctor(message, code, cause === undefined ? undefined : { cause });
}

export function isAbortError(error) {
	return (error instanceof DOMException && error.name === "AbortError") || error?.name === "AbortError";
}

export function throwIfAborted(signal, what = "request") {
	if (signal?.aborted === true) {
		const err = new Error(`${what} aborted`, { cause: signal.reason });
		err.name = "AbortError";
		throw err;
	}
}

/**
 * Combine an optional caller signal with a timeout into one AbortSignal.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs  `<= 0` disables the timeout.
 * @returns {{ signal: AbortSignal, cleanup: () => void, timedOut: () => boolean }}
 */
export function withTimeout(signal, timeoutMs) {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const timer = timeoutMs > 0 ? setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`timed out after ${timeoutMs} ms`));
	}, timeoutMs) : undefined;
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cleanup: () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

/**
 * `fetch` with a timeout merged into the abort signal. Rethrows abort as-is;
 * the caller decides how to map it (usually `WEB_ABORTED` vs `WEB_PROVIDER_ERROR`).
 * @param {string | URL} url
 * @param {RequestInit} init
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function fetchWithTimeout(url, init = {}, options = {}) {
	const { signal, cleanup, timedOut } = withTimeout(options.signal, options.timeoutMs ?? 20_000);
	try {
		return await fetch(url, { ...init, signal });
	} catch (error) {
		if (timedOut()) {
			const err = new Error(`request to ${String(url)} timed out after ${options.timeoutMs ?? 20_000} ms`, { cause: error });
			err.name = "TimeoutError";
			throw err;
		}
		throw error;
	} finally {
		cleanup();
	}
}

/** Race a promise against an abort signal (for credential lookups etc.). */
export function abortable(operation, signal) {
	if (signal === undefined) return operation;
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			const err = new Error("aborted", { cause: signal.reason });
			err.name = "AbortError";
			reject(err);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
			(e) => { signal.removeEventListener("abort", onAbort); reject(e); },
		);
	});
}
