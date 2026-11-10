import { TYPERT_REMOTE } from "../../lib/typert.remote-client.js";
import { WebProvidersSection, C } from "./WebProvidersSection.jsx";
import { NS, zh, en } from "./locales.js";

export { NS };

const PLUGIN_ID = "@baoson/dsh-web-provider-selector";
const REMOTE_SERVICE = "remote.webProviders";

const css = `
.${C}-section{width:100%;max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:20px}
.${C}-section h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.${C}-section h3{margin:0 0 8px;font-size:13px;line-height:20px;font-weight:600}
.${C}-section p{margin:0}
.${C}-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.${C}-muted{color:var(--dsw-alias-label-tertiary)}
.${C}-warn{color:var(--dsw-alias-state-warning-primary,#b7791f)}
.${C}-error{color:var(--dsw-alias-state-error-primary)}
.${C}-notice{color:var(--dsw-alias-state-business-primary)}
.${C}-failure{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-state-error-primary)}
.${C}-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.${C}-group{display:flex;flex-direction:column}
.${C}-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.${C}-row{padding:8px 12px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.${C}-row:first-child{border-top:none}
.${C}-row[data-row-state=active]{background:var(--dsw-alias-bg-layer-2,transparent);box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary)}
.${C}-row[data-row-state=catalog]{border-top-style:dashed}
.${C}-row[data-row-state=catalog] .${C}-rowTitle,.${C}-row[data-row-state=unavailable] .${C}-rowTitle{opacity:.55}
.${C}-rowMain{display:flex;align-items:center;gap:10px;min-height:28px}
.${C}-dot{flex:none}
.${C}-dotOff{display:inline-block;width:10px;height:10px;border-radius:50%;box-sizing:border-box;border:1.5px solid var(--dsw-alias-label-tertiary)}
.${C}-rowTitle{flex:1;min-width:0;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden}
.${C}-label{overflow:hidden;text-overflow:ellipsis}
.${C}-rowStatus{flex:none;font-size:12px;line-height:18px;min-width:80px;text-align:right}
.${C}-rowStatus:empty{display:none}
.${C}-rowActions{display:flex;align-items:center;gap:4px;flex:none;min-width:72px;justify-content:flex-end}
.${C}-activeBadge{font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color,#fff)}
.${C}-keyEditor{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}
.${C}-keyEditor>span,.${C}-keyEditor input{flex:1;min-width:220px}
.${C}-keyEditor p{flex-basis:100%}
.${C}-mountHint{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2);font-size:12px;line-height:18px}
.${C}-snippet{display:flex;align-items:flex-start;gap:8px}
.${C}-snippet pre{flex:1;margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));white-space:pre;overflow-x:auto}
`;

function injectStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`) !== null) return;
	const tag = document.createElement("style");
	tag.setAttribute("data-plugin", PLUGIN_ID);
	tag.textContent = css;
	document.head.appendChild(tag);
}

/**
 * Services the browser half needs. `remote.webProviders` is deliberately NOT
 * listed: that namespace service only exists after this plugin itself mounts
 * `TYPERT_REMOTE`, so listing it would deadlock activation. We inject the
 * `remote` mount service, mount, then scope the slot registration on the
 * namespace with `ctx.inject`.
 */
export const inject = ["slots", "locale", "remote"];

/** @param {any} ctx client cordis context */
export async function apply(ctx) {
	injectStyles();
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "web-provider-selector: dictionaries");
	const t = ctx.locale.bind(NS);

	// Installs `remote.webProviders` (rides this fiber; disposed with it).
	await ctx.remote.$mount(TYPERT_REMOTE);

	ctx.inject([REMOTE_SERVICE], (rctx) => {
		const remote = rctx.get(REMOTE_SERVICE);
		const unwrap = (result, method) => {
			if (!result.ok) throw new Error(`webProviders.${method} failed: ${result.error.code}: ${result.error.message}`);
			return result.value;
		};
		const api = {
			list: async () => unwrap(await remote.list(), "list"),
			select: async (kind, id) => unwrap(await remote.select(kind, id), "select"),
			setKey: async (ref, value) => unwrap(await remote.setKey(ref, value), "setKey"),
			unsetKey: async (ref) => unwrap(await remote.unsetKey(ref), "unsetKey"),
		};
		const injected = () => ({ api, t });
		rctx.slots.inject("settings.section", () => rctx.slots.register({
			name: "settings.section",
			id: "web-providers",
			order: 40,
			label: () => t("nav"),
			inject: injected,
		}, WebProvidersSection));
	});
}
