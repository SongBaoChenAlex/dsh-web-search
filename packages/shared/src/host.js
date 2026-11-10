/**
 * Import a DSH host package (`@deepseek-ai/*`) from inside a third-party plugin.
 *
 * Why this exists: a plugin installed with `dsh plugin add ./path` lives
 * outside the DSH installation, and Node resolves bare specifiers relative to
 * the *importing file*. DSH resolves plugin ENTRY modules against the host, but
 * an `import("@deepseek-ai/…")` executed *inside* the plugin resolves normally
 * and fails with ERR_MODULE_NOT_FOUND — silently, if wrapped in a fallback.
 *
 * Fix: ask the Node module loader DSH exposes as `ctx.loader.internal` to
 * resolve the specifier relative to a URL that is inside the installation. The
 * caller's stack always contains a frame from `@deepseek-ai/cordis` (the
 * plugin's `apply` is invoked by it), and that file's URL is a valid anchor.
 *
 * Outside a DSH process (unit tests, host-root installs) we fall back to a
 * plain `import()`; when that also fails the result is `undefined` so the
 * caller decides whether to degrade or throw.
 *
 * @module @tobedone4byme/dsh-web-shared/host
 */

const cache = new Map();

/**
 * @template T
 * @param {any} ctx          a cordis Context (any plugin's `ctx`)
 * @param {string} specifier e.g. "@deepseek-ai/dsh-tools"
 * @returns {Promise<T | undefined>}
 */
export async function importHost(ctx, specifier) {
	if (cache.has(specifier)) return cache.get(specifier);
	const anchors = hostAnchorsFromStack();
	const promise = (async () => {
		const internal = ctx?.loader?.internal ?? ctx?.get?.("loader")?.internal;
		if (internal) {
			for (const anchor of anchors) {
				try {
					return await internal.import(specifier, anchor, {});
				} catch {
					// try the next anchor
				}
			}
		}
		try {
			return await import(specifier);
		} catch {
			return undefined;
		}
	})();
	cache.set(specifier, promise);
	return promise;
}

/**
 * Like {@link importHost} but throws a clear error instead of returning `undefined`.
 * @template T
 * @param {any} ctx
 * @param {string} specifier
 * @returns {Promise<T>}
 */
export async function requireHost(ctx, specifier) {
	const mod = await importHost(ctx, specifier);
	if (mod === undefined) {
		throw new Error(`cannot resolve host package "${specifier}" from this plugin — it must run inside a DeepSeek Harness installation (dsh plugin add …)`);
	}
	return mod;
}

/**
 * Candidate parent URLs taken from already-loaded host frames on the current
 * stack: any `file:///…/node_modules/@deepseek-ai/<pkg>/` directory is inside
 * the installation. Ordered as they appear (innermost first).
 * @returns {string[]}
 */
export function hostAnchorsFromStack() {
	const out = new Set();
	const stack = new Error().stack ?? "";
	for (const match of stack.matchAll(/(file:\/\/\/[^\s)]*?\/node_modules\/@deepseek-ai\/[^/\s)]+\/)/gu)) {
		out.add(match[1]);
	}
	return [...out];
}

/** Clear the memoized modules (tests only). */
export function resetHostImportCache() {
	cache.clear();
}
