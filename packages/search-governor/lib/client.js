window.__ModuleLoader__.load({
	id: "@tobedone4byme/dsh-web-search-governor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		// ---- esbuild cjs bundle ----
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
		
		// src/client/index.jsx
		var index_exports = {};
		__export(index_exports, {
		  NAMESPACE: () => NAMESPACE,
		  NS: () => NS,
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(index_exports);
		
		// src/client/GovernorSection.jsx
		var import_react = require("react");
		var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		
		// src/client/form.js
		var NAMESPACE = "web-search-governor";
		var FIELDS = Object.freeze([
		  { key: "budgetPerSession", kind: "int", group: "budget" },
		  { key: "budgetNotice", kind: "textarea", group: "budget" },
		  { key: "maxSources", kind: "int", group: "shaping" },
		  { key: "snippetMaxChars", kind: "int", group: "shaping" },
		  { key: "contentMaxChars", kind: "int", group: "shaping" },
		  { key: "stripTrackingParams", kind: "bool", group: "shaping" },
		  { key: "activeProvider", kind: "text", group: "shaping" },
		  { key: "cache", kind: "bool", group: "repeat" },
		  { key: "cacheTtlMs", kind: "int", group: "repeat" },
		  { key: "nearDuplicate", kind: "bool", group: "repeat" },
		  { key: "nearDuplicateThreshold", kind: "ratio", group: "repeat" },
		  { key: "nearDuplicateMode", kind: "enum", group: "repeat", options: ["notice", "block"] },
		  { key: "guidance", kind: "bool", group: "misc", restart: true },
		  { key: "logAccounting", kind: "bool", group: "misc" }
		]);
		var GROUPS = Object.freeze(["budget", "shaping", "repeat", "misc"]);
		function specOf(key) {
		  const spec = FIELDS.find((f) => f.key === key);
		  if (spec === void 0) throw new Error(`governor form has no field ${key}`);
		  return spec;
		}
		function format(spec, value) {
		  switch (spec.kind) {
		    case "bool":
		      return value === true ? "true" : value === false ? "false" : "";
		    case "int":
		    case "ratio":
		      return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
		    default:
		      return typeof value === "string" ? value : "";
		  }
		}
		function parse(spec, text) {
		  const trimmed = String(text ?? "").trim();
		  if (trimmed === "") return { kind: "clear" };
		  switch (spec.kind) {
		    case "bool":
		      if (trimmed === "true") return { kind: "set", value: true };
		      if (trimmed === "false") return { kind: "set", value: false };
		      return void 0;
		    case "int": {
		      if (!/^\d+$/u.test(trimmed)) return void 0;
		      const n = Number(trimmed);
		      return Number.isSafeInteger(n) ? { kind: "set", value: n } : void 0;
		    }
		    case "ratio": {
		      const n = Number(trimmed);
		      return Number.isFinite(n) && n >= 0 && n <= 1 ? { kind: "set", value: n } : void 0;
		    }
		    case "enum":
		      return spec.options?.includes(trimmed) ? { kind: "set", value: trimmed } : void 0;
		    case "textarea":
		      return { kind: "set", value: String(text) };
		    default:
		      return { kind: "set", value: trimmed };
		  }
		}
		function stored(snapshot, key) {
		  const user = snapshot?.user;
		  return user !== void 0 && user !== null && Object.hasOwn(user, key);
		}
		function fieldState(spec, snapshot, drafts) {
		  const draft = drafts[spec.key];
		  const effective = snapshot?.value?.[spec.key];
		  const fallback = snapshot?.base?.[spec.key];
		  if (draft === void 0) {
		    return { text: format(spec, effective), overridden: stored(snapshot, spec.key), invalid: false, dirty: false, effective, fallback };
		  }
		  const write = draft.clear ? { kind: "clear" } : parse(spec, draft.text);
		  return {
		    text: draft.text,
		    overridden: write?.kind === "set",
		    invalid: write === void 0,
		    dirty: true,
		    effective,
		    fallback
		  };
		}
		function plan(snapshot, drafts) {
		  const out = [];
		  for (const [key, draft] of Object.entries(drafts)) {
		    const spec = specOf(key);
		    if (draft.clear) {
		      if (stored(snapshot, key)) out.push({ field: key, op: "unset" });
		      continue;
		    }
		    if (draft.text === format(spec, snapshot?.value?.[key])) continue;
		    const write = parse(spec, draft.text);
		    if (write === void 0) out.push({ field: key, op: void 0 });
		    else if (write.kind === "clear") {
		      if (stored(snapshot, key)) out.push({ field: key, op: "unset" });
		    } else out.push({ field: key, op: "set", value: write.value });
		  }
		  return out;
		}
		function shell(snapshot, drafts) {
		  const writes = plan(snapshot, drafts);
		  return {
		    available: snapshot?.status === "ready",
		    writable: snapshot?.writable === true,
		    dirty: writes.length > 0,
		    invalid: writes.some((w) => w.op === void 0)
		  };
		}
		function summary(value) {
		  if (value === void 0 || value === null) return "";
		  const n = (v, inf) => typeof v === "number" ? v === 0 ? inf : String(v) : "?";
		  return `${n(value.maxSources, "\u221E")} sources \xB7 ${n(value.snippetMaxChars, "\u221E")} chars/snippet \xB7 ${n(value.budgetPerSession, "\u221E")} searches/session`;
		}
		
		// src/client/GovernorSection.jsx
		var import_jsx_runtime = require("react/jsx-runtime");
		var C = "bwsg";
		function useScope(scope) {
		  return (0, import_react.useSyncExternalStore)(
		    (0, import_react.useCallback)((listener) => scope.subscribe(listener), [scope]),
		    () => scope.getSnapshot(),
		    () => scope.getSnapshot()
		  );
		}
		function Badges({ state, spec, t, disabled, onReset }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: `${C}-badges`, children: [
		    spec.restart ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `${C}-badgeMuted`, title: t("restartHint"), children: "\u21BB" }) : null,
		    state.overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `${C}-badge`, children: t("overridden") }) : null,
		    state.overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: `${C}-reset`, disabled, onClick: onReset, children: t("reset") }) : null
		  ] });
		}
		function Control({ spec, state, t, disabled, onEdit }) {
		  const id = `governor-${spec.key}`;
		  const cls = state.invalid ? `${C}-input ${C}-invalid` : `${C}-input`;
		  switch (spec.kind) {
		    case "bool":
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { id, className: cls, disabled, value: state.text, onChange: (e) => onEdit(e.target.value), children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: "", children: [
		          t("inherit"),
		          state.fallback !== void 0 ? ` (${state.fallback ? t("yes") : t("no")})` : ""
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "true", children: t("yes") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "false", children: t("no") })
		      ] });
		    case "enum":
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { id, className: cls, disabled, value: state.text, onChange: (e) => onEdit(e.target.value), children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: "", children: [
		          t("inherit"),
		          typeof state.fallback === "string" ? ` (${state.fallback})` : ""
		        ] }),
		        (spec.options ?? []).map((o) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: o, children: t(`mode_${o}`) }, o))
		      ] });
		    case "textarea":
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { id, className: cls, rows: 3, disabled, value: state.text, spellCheck: false, onChange: (e) => onEdit(e.target.value) });
		    default:
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "input",
		        {
		          id,
		          className: cls,
		          type: "text",
		          inputMode: spec.kind === "int" || spec.kind === "ratio" ? "decimal" : void 0,
		          disabled,
		          value: state.text,
		          placeholder: state.fallback !== void 0 && state.fallback !== "" ? String(state.fallback) : "",
		          spellCheck: false,
		          onChange: (e) => onEdit(e.target.value)
		        }
		      );
		  }
		}
		function Field({ spec, snapshot, drafts, t, disabled, onEdit, onReset }) {
		  const state = fieldState(spec, snapshot, drafts);
		  const effective = state.effective;
		  const showEffective = state.dirty && effective !== void 0 && String(effective) !== state.text;
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-field`, "data-field": spec.key, "data-invalid": state.invalid ? "true" : void 0, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-head`, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: `${C}-label`, htmlFor: `governor-${spec.key}`, children: t(spec.key) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badges, { state, spec, t, disabled, onReset })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Control, { spec, state, t, disabled, onEdit }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: state.invalid ? `${C}-hintInvalid` : `${C}-hint`, children: [
		      state.invalid ? t("invalid") : t(`${spec.key}_hint`),
		      showEffective ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: `${C}-muted`, children: [
		        " \xB7 ",
		        t("effective"),
		        ": ",
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: `${C}-mono`, children: String(effective) })
		      ] }) : null
		    ] })
		  ] });
		}
		function GovernorSection({ scope, t }) {
		  const snapshot = useScope(scope);
		  const [drafts, setDrafts] = (0, import_react.useState)(
		    /** @type {Record<string, { text: string, clear?: boolean }>} */
		    {}
		  );
		  const [saving, setSaving] = (0, import_react.useState)(false);
		  const [notice, setNotice] = (0, import_react.useState)(
		    /** @type {{ text: string, error: boolean } | null} */
		    null
		  );
		  const flags = (0, import_react.useMemo)(() => shell(snapshot, drafts), [snapshot, drafts]);
		  const disabled = !flags.available || !flags.writable || saving;
		  const edit = (key, text) => {
		    setNotice(null);
		    setDrafts((d) => ({ ...d, [key]: { text, clear: false } }));
		  };
		  const reset = (key) => {
		    setNotice(null);
		    setDrafts((d) => ({ ...d, [key]: { text: "", clear: true } }));
		  };
		  const discard = () => {
		    setDrafts({});
		    setNotice(null);
		  };
		  const save = async () => {
		    const writes = plan(snapshot, drafts);
		    if (writes.length === 0 || writes.some((w) => w.op === void 0)) return;
		    setSaving(true);
		    setNotice(null);
		    try {
		      for (const w of writes) {
		        if (w.op === "set") await scope.set(w.field, w.value);
		        else await scope.unset(w.field);
		      }
		      await scope.load();
		      const after = scope.getSnapshot();
		      const landed = writes.every((w) => w.op === "set" ? after.user?.[w.field] === w.value : !(after.user && Object.hasOwn(after.user, w.field)));
		      if (landed) {
		        setDrafts({});
		        setNotice({ text: t("saved"), error: false });
		      } else {
		        setNotice({ text: t("saveFailed"), error: true });
		      }
		    } catch {
		      setNotice({ text: t("saveFailed"), error: true });
		    } finally {
		      setSaving(false);
		    }
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-section`, "aria-busy": snapshot.status === "loading", children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: `${C}-header`, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: t("title") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-muted`, children: t("intro") }),
		        snapshot.status === "ready" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-mono ${C}-summary`, children: summary(snapshot.value) }) : null
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: () => void scope.load(), children: t("refresh") })
		    ] }),
		    snapshot.status === "loading" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-muted`, children: t("loading") }) : null,
		    snapshot.status === "unavailable" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-warn`, role: "status", children: t("unavailable") }) : null,
		    snapshot.status === "ready" && !flags.writable ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-warn`, role: "status", children: t("readOnly") }) : null,
		    snapshot.status === "ready" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		      GROUPS.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: `${C}-group`, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t(`group_${group}`) }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `${C}-grid`, children: FIELDS.filter((f) => f.group === group).map((spec) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          Field,
		          {
		            spec,
		            snapshot,
		            drafts,
		            t,
		            disabled,
		            onEdit: (text) => edit(spec.key, text),
		            onReset: () => reset(spec.key)
		          },
		          spec.key
		        )) })
		      ] }, group)),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("footer", { className: `${C}-footer`, children: [
		        notice !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: notice.error ? `${C}-error` : `${C}-notice`, role: notice.error ? "alert" : "status", children: notice.text }) : null,
		        flags.dirty && notice === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-muted`, children: flags.invalid ? t("invalid") : t("unsaved") }) : null,
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `${C}-spacer` }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", disabled: !flags.dirty || saving, onClick: discard, children: t("discard") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", disabled: !flags.dirty || flags.invalid || disabled, onClick: () => void save(), children: saving ? t("saving") : t("save") })
		      ] })
		    ] }) : null
		  ] });
		}
		
		// src/client/locales.js
		var NS = "settings.webSearchGovernor";
		var zh = {
		  nav: "\u641C\u7D22\u6CBB\u7406",
		  title: "Web \u641C\u7D22\u6CBB\u7406 (governor)",
		  intro: "\u63A7\u5236\u6A21\u578B\u6BCF\u6B21 web_search \u8BFB\u591A\u5C11\u3001\u4E00\u4E2A\u4F1A\u8BDD\u641C\u591A\u5C11\u6B21\u3002\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\uFF0C\u5199\u5165\u5F53\u524D profile \u7684 cordis.patch.yml\uFF08web-search-governor \u884C\uFF09\u3002",
		  loading: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026",
		  unavailable: "governor \u672A\u6302\u8F7D\u6216\u8BBE\u7F6E\u670D\u52A1\u4E0D\u53EF\u7528\u3002",
		  readOnly: "\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\uFF1A\u5F53\u524D\u8FDE\u63A5\u4E0D\u80FD\u5199\u5165\u3002",
		  refresh: "\u5237\u65B0",
		  save: "\u4FDD\u5B58",
		  saving: "\u4FDD\u5B58\u4E2D\u2026",
		  discard: "\u653E\u5F03\u4FEE\u6539",
		  saved: "\u5DF2\u4FDD\u5B58",
		  saveFailed: "\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6570\u503C\u540E\u91CD\u8BD5\u3002",
		  unsaved: "\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539",
		  invalid: "\u6709\u65E0\u6548\u7684\u503C",
		  overridden: "\u5DF2\u8986\u76D6",
		  reset: "\u6062\u590D\u9ED8\u8BA4",
		  effective: "\u5F53\u524D\u751F\u6548",
		  fallback: "\u9ED8\u8BA4",
		  restartHint: "\u9700\u8981\u91CD\u542F DSH \u624D\u751F\u6548",
		  yes: "\u5F00",
		  no: "\u5173",
		  inherit: "\u8DDF\u968F\u9ED8\u8BA4",
		  zeroUnlimited: "0 = \u4E0D\u9650",
		  group_budget: "\u6B21\u6570\u9884\u7B97",
		  group_shaping: "\u7ED3\u679C\u6574\u5F62\uFF08\u6BCF\u6B21\u8BFB\u591A\u5C11\uFF09",
		  group_repeat: "\u91CD\u590D\u67E5\u8BE2",
		  group_misc: "\u5176\u4ED6",
		  budgetPerSession: "\u6BCF\u4F1A\u8BDD\u641C\u7D22\u6B21\u6570\u4E0A\u9650",
		  budgetPerSession_hint: "\u8D85\u8FC7\u540E web_search \u76F4\u63A5\u8FD4\u56DE\u63D0\u793A\uFF0C\u4E0D\u518D\u8C03\u7528 provider\u30020 = \u4E0D\u9650\u3002",
		  budgetNotice: "\u9884\u7B97\u8017\u5C3D\u65F6\u8FD4\u56DE\u7ED9\u6A21\u578B\u7684\u6587\u5B57",
		  budgetNotice_hint: "\u7559\u7A7A\u4F7F\u7528\u5185\u7F6E\u6587\u6848\u3002",
		  maxSources: "\u4FDD\u7559\u6765\u6E90\u6570",
		  maxSources_hint: "\u6309 URL \u53BB\u91CD\u540E\u4FDD\u7559\u7684\u6761\u6570\u30020 = \u4E0D\u9650\u3002",
		  snippetMaxChars: "\u6BCF\u6761 snippet \u6700\u5927\u5B57\u7B26\u6570",
		  snippetMaxChars_hint: "0 = \u4E0D\u9650\u3002Tavily \u7B49 LLM \u539F\u751F\u641C\u7D22\u53EF\u9002\u5F53\u653E\u5927\uFF08\u89C1 providerOverrides\uFF09\u3002",
		  contentMaxChars: "\u7EFC\u5408\u7B54\u6848\u6700\u5927\u5B57\u7B26\u6570",
		  contentMaxChars_hint: "provider \u8FD4\u56DE\u7684 answer/content \u7684\u4E0A\u9650\u30020 = \u4E0D\u9650\u3002",
		  stripTrackingParams: "\u53BB\u9664 URL \u8FFD\u8E2A\u53C2\u6570",
		  stripTrackingParams_hint: "\u79FB\u9664 utm_*\u3001fbclid\u3001gclid \u7B49\u3002",
		  activeProvider: "\u5F53\u524D\u641C\u7D22 provider id",
		  activeProvider_hint: "\u51B3\u5B9A\u5957\u7528 providerOverrides \u91CC\u54EA\u4E00\u7EC4\u8986\u76D6\uFF08\u4F8B\u5982 tavily \u2192 snippet 800\uFF09\u3002\u5E94\u4E0E Web \u63D0\u4F9B\u8005\u9875\u9762\u9009\u4E2D\u7684\u641C\u7D22 provider \u4E00\u81F4\u3002",
		  cache: "\u76F8\u540C\u67E5\u8BE2\u7F13\u5B58",
		  cache_hint: "\u540C\u4E00\u4F1A\u8BDD\u5185\u5B8C\u5168\u76F8\u540C\u7684\u67E5\u8BE2\u76F4\u63A5\u8FD4\u56DE\u4E0A\u6B21\u7ED3\u679C\u3002",
		  cacheTtlMs: "\u7F13\u5B58\u6709\u6548\u671F\uFF08\u6BEB\u79D2\uFF09",
		  cacheTtlMs_hint: "\u9ED8\u8BA4 1800000\uFF0830 \u5206\u949F\uFF09\u3002",
		  nearDuplicate: "\u68C0\u6D4B\u6539\u5199\u7684\u91CD\u590D\u67E5\u8BE2",
		  nearDuplicate_hint: "\u7528\u8BCD\u5E72\u5316\u540E\u7684 Jaccard \u76F8\u4F3C\u5EA6\u8BC6\u522B\u6362\u4E2A\u8BF4\u6CD5\u7684\u91CD\u641C\u3002",
		  nearDuplicateThreshold: "\u8FD1\u4F3C\u91CD\u590D\u9608\u503C (0\u20131)",
		  nearDuplicateThreshold_hint: "\u76F8\u4F3C\u5EA6 \u2265 \u9608\u503C\u5373\u5224\u4E3A\u8FD1\u4F3C\u91CD\u590D\u3002\u9ED8\u8BA4 0.5\u3002",
		  nearDuplicateMode: "\u8FD1\u4F3C\u91CD\u590D\u5904\u7406\u65B9\u5F0F",
		  nearDuplicateMode_hint: "notice\uFF1A\u7167\u5E38\u641C\u7D22\u4F46\u5728\u7ED3\u679C\u524D\u52A0\u4E00\u884C\u63D0\u9192\uFF1Bblock\uFF1A\u4E0D\u8C03\u7528 provider\uFF0C\u76F4\u63A5\u8FD4\u56DE\u4E0A\u6B21\u7ED3\u679C\u3002",
		  mode_notice: "notice \u2014 \u63D0\u9192",
		  mode_block: "block \u2014 \u62E6\u622A",
		  guidance: "\u6CE8\u5165\u300C\u8D1F\u8D23\u4EFB\u5730\u4F7F\u7528\u641C\u7D22\u300D\u7CFB\u7EDF\u63D0\u793A",
		  guidance_hint: "\u5728 tool:web_search \u4E4B\u540E\u52A0\u4E00\u6BB5\u5F15\u5BFC\u3002",
		  logAccounting: "\u8BB0\u5F55 token \u8D26\u672C\u65E5\u5FD7",
		  logAccounting_hint: "\u6BCF\u6B21\u641C\u7D22\u8F93\u51FA\u4E00\u884C raw \u2192 shaped token \u7EDF\u8BA1\u3002"
		};
		var en = {
		  nav: "Search governor",
		  title: "Web search governor",
		  intro: "Controls how much the model reads per web_search and how often it may search per session. Saves apply live and are written to the active profile's cordis.patch.yml (the web-search-governor entry).",
		  loading: "Reading settings\u2026",
		  unavailable: "The governor is not mounted or the settings service is unavailable.",
		  readOnly: "Settings are read-only on this connection.",
		  refresh: "Refresh",
		  save: "Save",
		  saving: "Saving\u2026",
		  discard: "Discard",
		  saved: "Saved",
		  saveFailed: "Save failed; check the values and retry.",
		  unsaved: "Unsaved changes",
		  invalid: "Some values are invalid",
		  overridden: "Overridden",
		  reset: "Reset",
		  effective: "Effective",
		  fallback: "Default",
		  restartHint: "Takes effect after a DSH restart",
		  yes: "On",
		  no: "Off",
		  inherit: "Inherit default",
		  zeroUnlimited: "0 = unlimited",
		  group_budget: "Search budget",
		  group_shaping: "Result shaping (how much is read)",
		  group_repeat: "Repeated queries",
		  group_misc: "Other",
		  budgetPerSession: "Searches per session",
		  budgetPerSession_hint: "Past this, web_search returns a notice instead of calling the provider. 0 = unlimited.",
		  budgetNotice: "Notice returned once the budget is exhausted",
		  budgetNotice_hint: "Leave empty for the built-in text.",
		  maxSources: "Sources kept",
		  maxSources_hint: "Sources kept after URL dedupe. 0 = unlimited.",
		  snippetMaxChars: "Snippet cap (chars)",
		  snippetMaxChars_hint: "0 = unlimited. LLM-native providers like Tavily may deserve more (see providerOverrides).",
		  contentMaxChars: "Synthesized answer cap (chars)",
		  contentMaxChars_hint: "Cap for the provider's answer/content. 0 = unlimited.",
		  stripTrackingParams: "Strip tracking params",
		  stripTrackingParams_hint: "Removes utm_*, fbclid, gclid, \u2026",
		  activeProvider: "Active search provider id",
		  activeProvider_hint: "Selects which providerOverrides entry applies (e.g. tavily \u2192 snippet 800). Keep it equal to the search provider chosen on the Web providers page.",
		  cache: "Cache identical queries",
		  cache_hint: "An identical query in the same session returns the earlier result.",
		  cacheTtlMs: "Cache TTL (ms)",
		  cacheTtlMs_hint: "Default 1800000 (30 minutes).",
		  nearDuplicate: "Detect rephrased repeats",
		  nearDuplicate_hint: "Jaccard similarity on stemmed tokens catches the same question asked differently.",
		  nearDuplicateThreshold: "Near-duplicate threshold (0\u20131)",
		  nearDuplicateThreshold_hint: "Similarity at or above this counts as a near-duplicate. Default 0.5.",
		  nearDuplicateMode: "Near-duplicate mode",
		  nearDuplicateMode_hint: "notice: search runs, one warning line is prepended; block: provider is skipped and the earlier result is returned.",
		  mode_notice: "notice \u2014 warn",
		  mode_block: "block \u2014 skip",
		  guidance: "Inject the responsible-search prompt section",
		  guidance_hint: "Adds a short paragraph right after tool:web_search.",
		  logAccounting: "Log the token ledger",
		  logAccounting_hint: "One raw \u2192 shaped token line per governed search."
		};
		
		// src/client/index.jsx
		var PLUGIN_ID = "@tobedone4byme/dsh-web-search-governor";
		var css = `
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
		var inject = ["slots", "locale", "configForms"];
		function scopeOf(form, describe) {
		  return {
		    getSnapshot: () => form.getSnapshot(),
		    subscribe: (listener) => form.subscribe(listener),
		    set: (field, value) => form.set(field, value),
		    unset: (field) => form.unset(field),
		    load: () => describe.ensure()
		  };
		}
		function apply(ctx) {
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
		      inject: injected
		    }, GovernorSection))),
		    "web-search-governor: settings section"
		  );
		}
		
		// ---- end bundle ----
		return module.exports;
	}
});
