/**
 * Host plugin: "Web providers" selector for the DSH Web GUI.
 *
 * Responsibilities:
 * 1. Apply the configured provider selection to the live `ctx.web` seam at
 *    boot and whenever the settings layer changes it.
 * 2. Expose the typert remote namespace `webProviders` (list / select /
 *    setKey / unsetKey) consumed by the client bundle in `lib/client.js`.
 *
 * Persistence:
 * - dsh >= 0.2: `@deepseek-ai/dsh-web` resolves the provider on EVERY call
 *   from its own volatile Config (`searchProvider` / `fetchProvider` on the
 *   `web` entry) and no longer exposes runtime setters. The selection
 *   therefore lives on the `web` entry: `select()` writes it through
 *   `ctx.settings.update(<web entry id>, patch)`; the loader updates the
 *   volatile references in place and the next `web_search` / `web_fetch`
 *   picks the new provider. This plugin's own `searchProvider` /
 *   `fetchProvider` fields are then ignored (kept so older profile patches
 *   still parse).
 * - dsh 0.1.x: the runtime exposes writable `searchProviderId` /
 *   `fetchProviderId`; the selection is applied live and persisted into this
 *   plugin's own entry, whose volatile edits re-apply it via
 *   `loader/volatile-update`.
 *
 * `@deepseek-ai/dsh-typert-protocol` is resolved against the DSH installation
 * via `importHost` (a bare import from a plugin directory does not resolve).
 * Outside a DSH install (tests) the plugin degrades to "apply the row config,
 * no remote".
 *
 * @module @baoson/dsh-web-provider-selector
 */
import { importHost } from "@baoson/dsh-web-shared/host";
import { plainConfig } from "@baoson/dsh-web-shared/volatile";
import z from "@deepseek-ai/schemastery";
import { catalog } from "@baoson/dsh-web-search-http/adapter";
import { ProviderSelectorCore, defineWebProviderSelector, SERVICE_KEY, NAMESPACE, unwrapCordis } from "./service.js";

export { ProviderSelectorCore, defineWebProviderSelector, SERVICE_KEY, NAMESPACE, KNOWN_PROVIDERS } from "./service.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-provider-selector";
/** The web seam is the only hard dependency; settings/credentials/typert are optional. */
export const inject = ["web"];
/** Default profile entry id (= settings namespace) from `cordis.patch.yml`. */
export const SETTINGS_NAMESPACE = "web-provider-selector";

export const Config = z.object({
	searchProvider: z.string().description("dsh 0.1.x only: active web search provider id. On dsh >= 0.2 set `searchProvider` on the `web` entry instead (the Web providers page does this).").volatile(),
	fetchProvider: z.string().description("dsh 0.1.x only: active web fetch provider id. On dsh >= 0.2 set `fetchProvider` on the `web` entry instead (the Web providers page does this).").volatile(),
});

/** Host packages must be resolved against the DSH installation; see @baoson/dsh-web-shared/host. */
const tryImport = (ctx, specifier) => importHost(ctx, specifier);

/** The profile entry id this fiber was mounted under; the settings forms are keyed by it. */
function entryIdOf(ctx) {
	const id = ctx?.fiber?.entry?.options?.id;
	return typeof id === "string" && id.length > 0 ? id : SETTINGS_NAMESPACE;
}

/** The profile entry id that mounts `@deepseek-ai/dsh-web` (its Config owns the selection on dsh >= 0.2). */
function webEntryIdOf(ctx) {
	const id = unwrapCordis(ctx.web)?.ctx?.fiber?.entry?.options?.id;
	return typeof id === "string" && id.length > 0 ? id : "web";
}

/**
 * @param {any} ctx cordis context with `web` injected
 * @param {{ searchProvider?: string, fetchProvider?: string }} [config]
 */
export async function apply(ctx, config = {}) {
	const selection = () => plainConfig(config);
	/** @type {{ update(ns: string, patch: object): Promise<void>, writable?: boolean } | undefined} */
	let settings;

	const core = new ProviderSelectorCore({
		web: () => ctx.web,
		credentials: () => ctx.get("credentials"),
		catalog,
		canPersist: () => settings !== undefined && settings.writable !== false,
		persist: async (patch) => {
			if (settings === undefined) throw new Error("provider-selector: settings service unavailable; selection applied live only");
			// SettingsForms.update(entryId, patch) merges into the profile's user layer; the loader then updates the volatile refs.
			const target = core.webOwnsSelection() ? webEntryIdOf(ctx) : entryIdOf(ctx);
			await settings.update(target, patch);
		},
	});

	// 1. Boot: apply the composition row config right away.
	core.applySelection(selection());

	// 2. Follow live edits of the volatile fields (settings UI, generic form, patch file).
	if (typeof ctx.on === "function") {
		ctx.on("loader/volatile-update", () => {
			core.applySelection(selection());
		});
	}

	// 3. Settings wiring (optional service): persistence + hide the auto-generated page (this plugin ships its own).
	if (typeof ctx.inject === "function") {
		ctx.inject(["settings"], (sctx) => {
			settings = sctx.settings;
			if (typeof sctx.settings.configure === "function") {
				sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), "web-provider-selector: settings presentation");
			}
			sctx.effect(() => () => {
				settings = undefined;
			}, "web-provider-selector: settings service");
		});
	}

	// 4. Remote service (optional protocol package).
	const protocol = await tryImport(ctx, "@deepseek-ai/dsh-typert-protocol");
	if (protocol === undefined) {
		ctx.logger?.warn?.("web-provider-selector: @deepseek-ai/dsh-typert-protocol not resolvable; the settings page remote is not exposed");
		return;
	}
	const WebProviderSelector = defineWebProviderSelector(protocol);
	// Registers itself as ctx[SERVICE_KEY] (effect on this fiber) and binds the `webProviders` wire namespace.
	new WebProviderSelector(ctx, core);
}
