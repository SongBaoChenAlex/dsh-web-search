import { GovernorSection, C } from "./GovernorSection.jsx";
import { NAMESPACE } from "./form.js";
import { NS, zh, en } from "./locales.js";

export { NS, NAMESPACE };

const PLUGIN_ID = "@tobedone4byme/dsh-web-search-governor";

const css = `
.${C}-section{width:100%;max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;font-size:13px;line-height:20px}
.${C}-section h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.${C}-section h3{margin:0 0 10px;font-size:13px;line-height:20px;font-weight:600}
.${C}-section p{margin:0}
.${C}-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.${C}-summary{margin-top:6px;color:var(--dsw-alias-label-secondary)}
.${C}-muted{color:var(--dsw-alias-label-tertiary)}
.${C}-warn{color:var(--dsw-alias-state-warning-primary,#b7791f)}
.${C}-error{color:var(--dsw-alias-state-error-primary)}
.${C}-notice{color:var(--dsw-alias-state-business-primary)}
.${C}-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.${C}-group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:12px 14px}
.${C}-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px 18px}
.${C}-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.${C}-field[data-field=budgetNotice],.${C}-field[data-field=activeProvider]{grid-column:1/-1}
.${C}-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:20px}
.${C}-label{font-weight:500}
.${C}-badges{display:inline-flex;align-items:center;gap:6px}
.${C}-badge,.${C}-badgeMuted{font-size:11px;line-height:16px;padding:0 7px;border-radius:999px}
.${C}-badge{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color,#fff)}
.${C}-badgeMuted{background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary)}
.${C}-reset{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-state-business-primary);cursor:pointer}
.${C}-reset:disabled{opacity:.5;cursor:default}
.${C}-input{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit}
.${C}-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.${C}-input:disabled{opacity:.6}
textarea.${C}-input{resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:12px}
.${C}-invalid{border-color:var(--dsw-alias-state-error-primary)}
.${C}-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${C}-hintInvalid{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.${C}-footer{display:flex;align-items:center;gap:8px;padding-top:4px}
.${C}-spacer{flex:1}
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
 * `configForms` (from `@deepseek-ai/dsh-client-ui-settings`, dsh >= 0.2) hands
 * out one shared form per Host plugin entry over the stock settings wire — no
 * custom remote is needed. The section registers only while the Host serves
 * the `web-search-governor` namespace, so a profile without the governor
 * shows no trace of the page.
 */
export const inject = ["slots", "locale", "configForms"];

/**
 * Adapt a `ConfigForm` to what `GovernorSection` expects: the 0.1.x
 * `SettingsScope` surface plus `load()`, which 0.2 no longer needs because
 * write answers fold into the form automatically.
 * @param {any} form `ctx.configForms.get(namespace)`
 * @param {any} describe `ctx.configForms.describe()`
 */
function scopeOf(form, describe) {
	return {
		getSnapshot: () => form.getSnapshot(),
		subscribe: (listener) => form.subscribe(listener),
		set: (field, value) => form.set(field, value),
		unset: (field) => form.unset(field),
		load: () => describe.ensure(),
	};
}

/** @param {any} ctx client cordis context */
export function apply(ctx) {
	injectStyles();
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "web-search-governor: dictionaries");
	const t = ctx.locale.bind(NS);
	const scope = scopeOf(ctx.configForms.get(NAMESPACE), ctx.configForms.describe());
	const injected = () => ({ scope, t });
	ctx.effect(
		() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "web-search-governor",
			order: 41,
			label: () => t("nav"),
			inject: injected,
		}, GovernorSection))),
		"web-search-governor: settings section",
	);
}
