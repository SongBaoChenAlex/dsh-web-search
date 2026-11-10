/**
 * Helpers for `.volatile()` Config fields (dsh >= 0.2 / schemastery >= 3.18.5).
 *
 * A volatile field parses into a frozen reference `{ get() }` that the Cordis
 * loader updates in place when the settings layer changes, instead of
 * re-applying the plugin. Plugins that read their config as plain values go
 * through {@link plainConfig} so the same code works for plain objects (tests,
 * older hosts) and reference-carrying configs alike.
 * @module @tobedone4byme/dsh-web-shared/volatile
 */

/** Same symbol `@deepseek-ai/cosmokit` brands its references with (shared across copies). */
const WRITE = Symbol.for("cosmokit.volatile.write");

/** @param {unknown} value */
export function isVolatile(value) {
	return typeof value === "object" && value !== null && WRITE in value && typeof (/** @type {any} */ (value)).get === "function";
}

/** Current value of a volatile reference, or the value itself when it is not one. */
export function unwrapVolatile(value) {
	return isVolatile(value) ? (/** @type {any} */ (value)).get() : value;
}

/**
 * Shallow copy of `config` with every top-level volatile reference replaced
 * by its current value.
 * @template T
 * @param {T} config
 * @returns {T}
 */
export function plainConfig(config) {
	if (typeof config !== "object" || config === null) return config;
	const out = /** @type {any} */ ({});
	for (const [key, value] of Object.entries(config)) out[key] = unwrapVolatile(value);
	return out;
}
