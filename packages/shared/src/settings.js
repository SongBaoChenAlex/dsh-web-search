/**
 * Thin wrapper over `@deepseek-ai/dsh-settings` so every plugin exposes a
 * hot-reloadable `~/.dsh/settings.yaml` section the same way.
 *
 * The host package is resolved through {@link importHost} (plugins live
 * outside the DSH installation, so a bare `import()` would fail). When it is
 * not resolvable at all (unit tests), `liveConfig` degrades to the static
 * config passed to `apply`.
 * @module @tobedone4byme/dsh-web-shared/settings
 */
import { importHost } from "./host.js";

/**
 * @param {any} ctx
 * @param {string} namespace  e.g. "web-search-tavily"
 * @param {any} Config        schemastery schema
 * @param {any} initial       config passed to `apply`
 * @param {(next: any) => void} [onChange]
 * @returns {() => any} `current()` — returns the latest merged config
 *   (the static `initial` until the settings service has been wired, or forever
 *   when `@deepseek-ai/dsh-settings` is unavailable).
 */
export function liveConfig(ctx, namespace, Config, initial, onChange) {
	let current = () => initial;
	void importHost(ctx, "@deepseek-ai/dsh-settings").then((mod) => {
		if (!mod) {
			ctx?.logger?.warn?.(`${namespace}: @deepseek-ai/dsh-settings not resolvable; settings.yaml section disabled, using static config`);
			return;
		}
		// dsh >= 0.2 derives forms from the entry Config schema and re-applies the
		// plugin on change, so `initial` is already live and nothing is installed.
		if (typeof mod.installSettingsSection !== "function" || typeof mod.settingsNamespace !== "function") return;
		try {
			mod.installSettingsSection(ctx, mod.settingsNamespace(namespace), Config, initial, {
				setSource: (source) => { current = source; },
				onChange: () => onChange?.(current()),
			});
		} catch (error) {
			ctx?.logger?.warn?.(`${namespace}: settings section not installed: ${String(error)}`);
		}
	});
	return () => current();
}
