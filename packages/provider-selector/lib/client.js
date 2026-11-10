window.__ModuleLoader__.load({
	id: "@tobedone4byme/dsh-web-provider-selector",
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
		  NS: () => NS,
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(index_exports);
		
		// lib/typert.remote-client.js
		var PACKAGE = "@tobedone4byme/dsh-web-provider-selector";
		var NAMESPACE = "webProviders";
		function codec(symbol, check) {
		  const parse = (value) => {
		    const problem = check(value);
		    if (problem !== void 0) throw new TypeError(`${symbol}: ${problem}`);
		    return value;
		  };
		  const schema = {
		    parse,
		    safeParse: (value) => {
		      try {
		        return { success: true, data: parse(value) };
		      } catch (error) {
		        return { success: false, error };
		      }
		    },
		    optional: () => schema,
		    nonoptional: () => schema,
		    "~standard": {
		      version: 1,
		      vendor: "@tobedone4byme/dsh-web-provider-selector",
		      validate: (value) => {
		        const problem = check(value);
		        return problem === void 0 ? { value } : { issues: [{ message: `${symbol}: ${problem}` }] };
		      }
		    }
		  };
		  return {
		    mode: "strict",
		    typeSymbol: `${PACKAGE}/types#${symbol}`,
		    schema,
		    create: () => schema,
		    decode: parse,
		    jsonSchemaError: `${PACKAGE}: hand-written codec ${symbol} has no JSON Schema`
		  };
		}
		var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
		var nonEmptyString = (v) => typeof v === "string" && v.length > 0 ? void 0 : "expected a non-empty string";
		var oneOfKind = (v) => v === "search" || v === "fetch" ? void 0 : 'expected "search" or "fetch"';
		var providerArray = (v) => Array.isArray(v) && v.every((p) => isObject(p) && typeof p.id === "string") ? void 0 : "expected Provider[]";
		var KIND = codec("ProviderKind", oneOfKind);
		var ID = codec("ProviderId", nonEmptyString);
		var REF = codec("CredentialRef", nonEmptyString);
		var SECRET = codec("CredentialValue", nonEmptyString);
		var LIST_RESULT = codec("ProviderListing", (v) => {
		  if (!isObject(v)) return "expected an object";
		  if (providerArray(v.search) !== void 0) return "search: expected Provider[]";
		  if (providerArray(v.fetch) !== void 0) return "fetch: expected Provider[]";
		  if (!isObject(v.active)) return "active: expected an object";
		  if (!Array.isArray(v.catalog)) return "catalog: expected an array";
		  return void 0;
		});
		var SELECT_RESULT = codec("SelectResult", (v) => isObject(v) && v.ok === true && isObject(v.active) ? void 0 : "expected { ok: true, active }");
		var KEY_RESULT = codec("KeyResult", (v) => isObject(v) && v.ok === true && typeof v.ref === "string" ? void 0 : "expected { ok: true, ref }");
		function descriptor(method, parameters, result) {
		  return {
		    id: `${PACKAGE}#${NAMESPACE}/${method}`,
		    service: "webProviderSelector",
		    namespace: NAMESPACE,
		    method,
		    invocation: { kind: "direct" },
		    parameters: parameters.map(([name, c]) => ({ name, wire: name, source: "json", codec: c })),
		    result
		  };
		}
		var TYPERT_REMOTE = {
		  package: PACKAGE,
		  descriptors: [
		    descriptor("list", [], LIST_RESULT),
		    descriptor("select", [["kind", KIND], ["id", ID]], SELECT_RESULT),
		    descriptor("setKey", [["ref", REF], ["value", SECRET]], KEY_RESULT),
		    descriptor("unsetKey", [["ref", REF]], KEY_RESULT)
		  ]
		};
		
		// src/client/WebProvidersSection.jsx
		var import_react = require("react");
		var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		
		// src/client/rows.js
		function rowState(row, active) {
		  if (row.registered !== true) return "catalog";
		  if (active) return "active";
		  if (row.usable !== false && row.available === true) return "usable";
		  if (row.keyEnv !== void 0 && row.keyConfigured === false) return "keyMissing";
		  return "unavailable";
		}
		function rowAction(state, row) {
		  switch (state) {
		    case "usable":
		      return "use";
		    case "keyMissing":
		      return row.keyEnv === void 0 ? null : "addKey";
		    case "catalog":
		      return row.keyEnv === void 0 ? null : "addKey";
		    default:
		      return null;
		  }
		}
		function fromProvider(provider, entry, active) {
		  const base = {
		    id: provider.id,
		    kind: provider.kind,
		    label: provider.label ?? entry?.label ?? provider.id,
		    providerKind: provider.providerKind ?? entry?.kind ?? "unknown",
		    description: provider.description ?? entry?.description,
		    registered: true,
		    available: provider.available,
		    usable: provider.usable,
		    keyEnv: provider.keyEnv ?? entry?.keyEnv,
		    keyConfigured: provider.keyConfigured ?? entry?.keyConfigured,
		    keySource: provider.keySource ?? entry?.keySource,
		    requiresKey: entry?.requiresKey,
		    docsUrl: entry?.docsUrl,
		    keyUrl: entry?.keyUrl,
		    freeTier: entry?.freeTier
		  };
		  return finish(base, active);
		}
		function fromCatalog(entry) {
		  return finish({
		    id: entry.id,
		    kind: "search",
		    label: entry.label ?? entry.id,
		    providerKind: entry.kind ?? "engine",
		    description: entry.description,
		    registered: false,
		    keyEnv: entry.keyEnv,
		    keyConfigured: entry.keyConfigured,
		    keySource: entry.keySource,
		    requiresKey: entry.requiresKey,
		    docsUrl: entry.docsUrl,
		    keyUrl: entry.keyUrl,
		    freeTier: entry.freeTier
		  }, false);
		}
		function finish(base, active) {
		  const state = rowState(base, active);
		  const out = {
		    ...base,
		    active,
		    state,
		    dot: state === "active" || state === "usable" ? "on" : "off",
		    action: rowAction(state, base)
		  };
		  delete out.available;
		  delete out.usable;
		  for (const key of Object.keys(out)) if (out[key] === void 0) delete out[key];
		  return out;
		}
		function mergeRows(listing) {
		  const catalog = Array.isArray(listing?.catalog) ? listing.catalog : [];
		  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
		  const active = listing?.active ?? {};
		  const table = (kind, providers, withCatalog) => {
		    const rows = [];
		    const seen = /* @__PURE__ */ new Set();
		    for (const provider of Array.isArray(providers) ? providers : []) {
		      if (seen.has(provider.id)) continue;
		      seen.add(provider.id);
		      rows.push(fromProvider({ kind, ...provider }, byId.get(provider.id), provider.id === active[kind]));
		    }
		    if (withCatalog) {
		      for (const entry of catalog) {
		        if (seen.has(entry.id)) continue;
		        seen.add(entry.id);
		        rows.push(fromCatalog(entry));
		      }
		    }
		    return rows;
		  };
		  return {
		    search: table("search", listing?.search, true),
		    fetch: table("fetch", listing?.fetch, false)
		  };
		}
		function mountSnippet(row) {
		  const keyEnv = row.keyEnv ?? `${row.id.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_API_KEY`;
		  return [
		    `- id: web-search-${row.id}`,
		    `  name: "@tobedone4byme/dsh-web-search-http"`,
		    `  config: { backend: ${row.id}, apiKeyEnv: ${keyEnv} }`
		  ].join("\n");
		}
		
		// src/client/WebProvidersSection.jsx
		var import_jsx_runtime = require("react/jsx-runtime");
		var C = "bwps";
		function errorMessage(error) {
		  return error instanceof Error ? error.message : String(error);
		}
		function KeyEditor({ keyEnv, configured, api, t, onDone }) {
		  const [value, setValue] = (0, import_react.useState)("");
		  const [busy, setBusy] = (0, import_react.useState)(
		    /** @type {"save"|"remove"|null} */
		    null
		  );
		  const [failure, setFailure] = (0, import_react.useState)(
		    /** @type {string|undefined} */
		    void 0
		  );
		  const save = async () => {
		    if (value.trim().length === 0) return;
		    setBusy("save");
		    setFailure(void 0);
		    try {
		      await api.setKey(keyEnv, value.trim());
		      setValue("");
		      onDone(t("keySaved", { ref: keyEnv }), "saved");
		    } catch (error) {
		      setFailure(errorMessage(error));
		    } finally {
		      setBusy(null);
		    }
		  };
		  const remove = async () => {
		    setBusy("remove");
		    setFailure(void 0);
		    try {
		      await api.unsetKey(keyEnv);
		      onDone(t("keyRemoved", { ref: keyEnv }), "removed");
		    } catch (error) {
		      setFailure(errorMessage(error));
		    } finally {
		      setBusy(null);
		    }
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-keyEditor`, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: `${C}-mono`, children: keyEnv }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      import_dsh_client_ui_primitives.Input,
		      {
		        type: "password",
		        autoComplete: "off",
		        spellCheck: false,
		        placeholder: t("keyPlaceholder"),
		        value,
		        disabled: busy !== null,
		        onChange: (event) => setValue(event.currentTarget.value),
		        onKeyDown: (event) => {
		          if (event.key === "Enter") void save();
		        }
		      }
		    ),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", disabled: busy !== null || value.trim().length === 0, onClick: () => void save(), children: busy === "save" ? t("saving") : t("save") }),
		    configured ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", disabled: busy !== null, onClick: () => void remove(), children: busy === "remove" ? t("removing") : t("remove") }) : null,
		    failure !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", className: `${C}-error`, children: failure }) : null
		  ] });
		}
		function MountHint({ row, t }) {
		  const [copied, setCopied] = (0, import_react.useState)(false);
		  const snippet = mountSnippet(row);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-mountHint`, "data-mount-hint": row.id, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: `${C}-muted`, children: [
		      t("mountHint"),
		      " ",
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: `${C}-mono`, children: "~/.dsh/profiles/web/cordis.patch.yml" }),
		      ":"
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-snippet`, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: `${C}-mono`, children: snippet }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Button,
		        {
		          variant: "ghost",
		          size: "sm",
		          onClick: () => {
		            void (0, import_dsh_client_ui_primitives.writeClipboard)(snippet).then((ok) => {
		              setCopied(ok);
		              if (ok) setTimeout(() => setCopied(false), 1500);
		            });
		          },
		          children: copied ? t("copied") : t("copy")
		        }
		      )
		    ] })
		  ] });
		}
		function StatusText({ row, t }) {
		  switch (row.state) {
		    case "active":
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `${C}-activeBadge`, children: t("active") });
		    case "keyMissing":
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `${C}-warn`, children: t("keyMissing") });
		    case "unavailable":
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `${C}-muted`, children: t("unavailable") });
		    case "catalog":
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `${C}-muted`, children: t("notMounted") });
		    default:
		      return null;
		  }
		}
		function RowMenu({ row, t, canEditKey, onEditKey, onRemoveKey }) {
		  const [open, setOpen] = (0, import_react.useState)(false);
		  const items = [];
		  if (row.docsUrl) items.push({ id: "docs", label: t("docs") });
		  if (row.keyUrl) items.push({ id: "keyUrl", label: t("getKey") });
		  if (row.freeTier) items.push({ id: "freeTier", label: `${t("freeTier")}: ${row.freeTier}`, disabled: true });
		  if (row.requiresKey === false) {
		    items.push({ id: "noKey", label: t("noKeyNeeded"), disabled: true });
		  } else if (row.keyEnv) {
		    if (items.length > 0) items.push({ type: "separator", id: "sep1" });
		    items.push({ id: "keyEnv", label: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		      t("keySource"),
		      ": ",
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: `${C}-mono`, children: row.keyEnv }),
		      row.keySource ? ` (${row.keySource})` : ""
		    ] }), disabled: true });
		    if (canEditKey) {
		      items.push({ id: "changeKey", label: row.keyConfigured === true ? t("changeKey") : t("addKey") });
		      if (row.keyConfigured === true) items.push({ id: "removeKey", label: t("removeKey"), danger: true });
		    }
		  }
		  if (items.length === 0) return null;
		  const onSelect = (id) => {
		    setOpen(false);
		    if (id === "docs" && typeof window !== "undefined") window.open(row.docsUrl, "_blank", "noopener,noreferrer");
		    else if (id === "keyUrl" && typeof window !== "undefined") window.open(row.keyUrl, "_blank", "noopener,noreferrer");
		    else if (id === "changeKey") onEditKey();
		    else if (id === "removeKey") onRemoveKey();
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		    import_dsh_client_ui_primitives.Menu,
		    {
		      open,
		      align: "end",
		      portal: true,
		      dense: true,
		      items,
		      onSelect,
		      onClose: () => setOpen(false),
		      anchor: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", "aria-label": t("more"), "aria-haspopup": "menu", "aria-expanded": open, "data-row-menu": row.id, onClick: () => setOpen((v) => !v), children: "?" })
		    }
		  );
		}
		function ProviderRow({ row, api, t, onNotice, busyId, setBusyId, credentialsWritable, expanded, setExpanded }) {
		  const [justSaved, setJustSaved] = (0, import_react.useState)(false);
		  const busy = busyId !== null;
		  const canEditKey = row.keyEnv !== void 0 && credentialsWritable;
		  const editing = expanded === row.id;
		  const kindLabel = t(`kind_${row.providerKind}`) === `kind_${row.providerKind}` ? row.providerKind : t(`kind_${row.providerKind}`);
		  const use = async () => {
		    setBusyId(row.id);
		    try {
		      await api.select(row.kind, row.id);
		      onNotice(t("selected", { id: row.id }));
		    } catch (error) {
		      onNotice(errorMessage(error), true);
		    } finally {
		      setBusyId(null);
		    }
		  };
		  const removeKey = async () => {
		    try {
		      await api.unsetKey(row.keyEnv);
		      onNotice(t("keyRemoved", { ref: row.keyEnv }));
		    } catch (error) {
		      onNotice(errorMessage(error), true);
		    }
		  };
		  let action = null;
		  if (row.action === "use") {
		    action = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", disabled: busy, onClick: () => void use(), children: t("use") });
		  } else if (row.action === "addKey") {
		    const button = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", disabled: !credentialsWritable, onClick: () => setExpanded(editing ? null : row.id), children: editing ? t("hideKey") : t("addKey") });
		    action = credentialsWritable ? button : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: t("noCredentials"), side: "top", children: button });
		  }
		  const showMountHint = row.state === "catalog" && (justSaved || row.keyConfigured === true);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		    "li",
		    {
		      className: `${C}-row`,
		      "data-provider": row.id,
		      "data-row-state": row.state,
		      "data-active": row.active ? "true" : void 0,
		      "data-usable": row.state === "active" || row.state === "usable" ? "true" : "false",
		      "data-registered": row.registered ? "true" : "false",
		      children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-rowMain`, children: [
		          row.dot === "on" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "done", size: 10, className: `${C}-dot` }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { "aria-hidden": "true", className: `${C}-dot ${C}-dotOff` }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-rowTitle`, children: [
		            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { className: `${C}-label`, children: row.label }),
		            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Pill, { className: `${C}-mono`, children: row.id }),
		            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Pill, { children: kindLabel })
		          ] }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `${C}-rowStatus`, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StatusText, { row, t }) }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-rowActions`, children: [
		            action,
		            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RowMenu, { row, t, canEditKey, onEditKey: () => setExpanded(row.id), onRemoveKey: () => void removeKey() })
		          ] })
		        ] }),
		        editing && row.keyEnv !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          KeyEditor,
		          {
		            keyEnv: row.keyEnv,
		            configured: row.keyConfigured === true,
		            api,
		            t,
		            onDone: (message, outcome) => {
		              setExpanded(null);
		              if (row.state === "catalog" && outcome === "saved") setJustSaved(true);
		              onNotice(message);
		            }
		          }
		        ) : null,
		        showMountHint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MountHint, { row, t }) : null
		      ]
		    }
		  );
		}
		function Table({ title, rows, ...rest }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: `${C}-group`, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: title }),
		    rows.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-muted`, children: rest.t("emptyGroup") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: `${C}-list`, children: rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProviderRow, { row, ...rest }, row.id)) })
		  ] });
		}
		function WebProvidersSection({ api, t }) {
		  const [state, setState] = (0, import_react.useState)(
		    /** @type {{ status: "loading" } | { status: "error", message: string } | { status: "ready", data: any }} */
		    { status: "loading" }
		  );
		  const [notice, setNotice] = (0, import_react.useState)(
		    /** @type {{ text: string, error: boolean } | null} */
		    null
		  );
		  const [busyId, setBusyId] = (0, import_react.useState)(
		    /** @type {string|null} */
		    null
		  );
		  const [expanded, setExpanded] = (0, import_react.useState)(
		    /** @type {string|null} */
		    null
		  );
		  const refresh = (0, import_react.useCallback)(async () => {
		    try {
		      const data2 = await api.list();
		      setState({ status: "ready", data: data2 });
		    } catch (error) {
		      setState({ status: "error", message: errorMessage(error) });
		    }
		  }, [api]);
		  (0, import_react.useEffect)(() => {
		    let current = true;
		    void api.list().then(
		      (data2) => {
		        if (current) setState({ status: "ready", data: data2 });
		      },
		      (error) => {
		        if (current) setState({ status: "error", message: errorMessage(error) });
		      }
		    );
		    return () => {
		      current = false;
		    };
		  }, [api]);
		  const onNotice = (text, error = false) => {
		    setNotice({ text, error });
		    void refresh();
		  };
		  const data = state.status === "ready" ? state.data : void 0;
		  const rows = data !== void 0 ? mergeRows(data) : void 0;
		  const shared = { api, t, onNotice, busyId, setBusyId, expanded, setExpanded, credentialsWritable: data?.credentialsWritable !== false };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-section`, "aria-busy": state.status === "loading", children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: `${C}-header`, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: t("title") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-muted`, children: t("intro") })
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: () => void refresh(), children: t("refresh") })
		    ] }),
		    state.status === "loading" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-muted`, children: t("loading") }) : null,
		    state.status === "error" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${C}-failure`, role: "alert", children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
		        t("error"),
		        ": ",
		        state.message
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", onClick: () => {
		        setState({ status: "loading" });
		        void refresh();
		      }, children: t("retry") })
		    ] }) : null,
		    notice !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: notice.error ? `${C}-error` : `${C}-notice`, role: notice.error ? "alert" : "status", children: notice.text }) : null,
		    data !== void 0 && rows !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		      data.persisted === false ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-warn`, children: t("notPersisted") }) : null,
		      data.credentialsWritable === false ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `${C}-warn`, children: t("noCredentials") }) : null,
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Table, { title: t("searchGroup"), rows: rows.search, ...shared }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Table, { title: t("fetchGroup"), rows: rows.fetch, ...shared })
		    ] }) : null
		  ] });
		}
		
		// src/client/locales.js
		var NS = "settings.webProviders";
		var zh = {
		  nav: "Web \u63D0\u4F9B\u8005",
		  title: "Web \u63D0\u4F9B\u8005",
		  intro: "\u9009\u62E9 web_search / web_fetch \u4F7F\u7528\u7684\u63D0\u4F9B\u8005\u3002\u5207\u6362\u7ACB\u5373\u751F\u6548\u5E76\u5199\u5165\u5F53\u524D profile \u7684 cordis.patch.yml\uFF08web \u884C\uFF09\u3002",
		  loading: "\u6B63\u5728\u8BFB\u53D6\u63D0\u4F9B\u8005\u2026",
		  error: "\u8BFB\u53D6\u5931\u8D25",
		  retry: "\u91CD\u8BD5",
		  refresh: "\u5237\u65B0",
		  searchGroup: "\u641C\u7D22\u63D0\u4F9B\u8005 (web_search)",
		  fetchGroup: "\u6293\u53D6\u63D0\u4F9B\u8005 (web_fetch)",
		  emptyGroup: "\u6CA1\u6709\u53EF\u7528\u7684\u63D0\u4F9B\u8005\u3002",
		  active: "\u5F53\u524D\u4F7F\u7528",
		  use: "\u4F7F\u7528",
		  unavailable: "\u4E0D\u53EF\u7528",
		  keyMissing: "\u7F3A\u5C11\u5BC6\u94A5",
		  notMounted: "\u672A\u6302\u8F7D",
		  keySource: "\u5BC6\u94A5\u6765\u6E90",
		  addKey: "\u6DFB\u52A0\u5BC6\u94A5",
		  changeKey: "\u66F4\u6362\u5BC6\u94A5",
		  removeKey: "\u79FB\u9664\u5BC6\u94A5",
		  hideKey: "\u6536\u8D77",
		  keyPlaceholder: "\u7C98\u8D34 API \u5BC6\u94A5",
		  save: "\u4FDD\u5B58",
		  saving: "\u4FDD\u5B58\u4E2D\u2026",
		  remove: "\u79FB\u9664",
		  removing: "\u79FB\u9664\u4E2D\u2026",
		  notPersisted: "\u8BBE\u7F6E\u670D\u52A1\u4E0D\u53EF\u7528\uFF1A\u5207\u6362\u4EC5\u5728\u672C\u6B21\u8FD0\u884C\u5185\u751F\u6548\u3002",
		  noCredentials: "\u51ED\u636E\u670D\u52A1\u4E0D\u53EF\u7528\uFF1A\u65E0\u6CD5\u4FDD\u5B58\u5BC6\u94A5\u3002",
		  mountHint: "\u672A\u6302\u8F7D \u2014 \u8BF7\u628A\u8FD9\u4E00\u6BB5\u6DFB\u52A0\u5230",
		  copy: "\u590D\u5236",
		  copied: "\u5DF2\u590D\u5236",
		  docs: "\u6587\u6863",
		  getKey: "\u83B7\u53D6\u5BC6\u94A5",
		  freeTier: "\u514D\u8D39\u989D\u5EA6",
		  more: "\u66F4\u591A",
		  kind_engine: "\u641C\u7D22\u5F15\u64CE",
		  "kind_search-engine": "\u641C\u7D22\u5F15\u64CE",
		  "kind_llm-native": "LLM \u539F\u751F",
		  "kind_model-embedded": "\u6A21\u578B\u5185\u5D4C",
		  "kind_self-hosted": "\u81EA\u6258\u7BA1",
		  noKeyNeeded: "\u65E0\u9700\u5BC6\u94A5",
		  kind_fetch: "\u6293\u53D6",
		  kind_unknown: "\u672A\u77E5",
		  selected: "\u5DF2\u5207\u6362\u5230 {id}",
		  keySaved: "\u5DF2\u4FDD\u5B58 {ref}",
		  keyRemoved: "\u5DF2\u79FB\u9664 {ref}"
		};
		var en = {
		  nav: "Web providers",
		  title: "Web providers",
		  intro: "Pick the provider behind web_search / web_fetch. Switching applies live and is written to the active profile's cordis.patch.yml (the web entry).",
		  loading: "Reading providers\u2026",
		  error: "Could not read providers",
		  retry: "Retry",
		  refresh: "Refresh",
		  searchGroup: "Search providers (web_search)",
		  fetchGroup: "Fetch providers (web_fetch)",
		  emptyGroup: "No providers available.",
		  active: "Active",
		  use: "Use",
		  unavailable: "Unavailable",
		  keyMissing: "Key missing",
		  notMounted: "Not mounted",
		  keySource: "Key source",
		  addKey: "Add key",
		  changeKey: "Change key",
		  removeKey: "Remove key",
		  hideKey: "Hide",
		  keyPlaceholder: "Paste API key",
		  save: "Save",
		  saving: "Saving\u2026",
		  remove: "Remove",
		  removing: "Removing\u2026",
		  notPersisted: "Settings service unavailable: the switch only lasts for this run.",
		  noCredentials: "Credentials service unavailable: keys cannot be stored.",
		  mountHint: "Not mounted \u2014 add this row to",
		  copy: "Copy",
		  copied: "Copied",
		  docs: "Docs",
		  getKey: "Get a key",
		  freeTier: "Free tier",
		  more: "More",
		  kind_engine: "search engine",
		  "kind_search-engine": "search engine",
		  "kind_llm-native": "LLM-native",
		  "kind_model-embedded": "model-embedded",
		  "kind_self-hosted": "self-hosted",
		  noKeyNeeded: "no key needed",
		  kind_fetch: "fetch",
		  kind_unknown: "unknown",
		  selected: "Switched to {id}",
		  keySaved: "Saved {ref}",
		  keyRemoved: "Removed {ref}"
		};
		
		// src/client/index.jsx
		var PLUGIN_ID = "@tobedone4byme/dsh-web-provider-selector";
		var REMOTE_SERVICE = "remote.webProviders";
		var css = `
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
		var inject = ["slots", "locale", "remote"];
		async function apply(ctx) {
		  injectStyles();
		  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "web-provider-selector: dictionaries");
		  const t = ctx.locale.bind(NS);
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
		      unsetKey: async (ref) => unwrap(await remote.unsetKey(ref), "unsetKey")
		    };
		    const injected = () => ({ api, t });
		    rctx.slots.inject("settings.section", () => rctx.slots.register({
		      name: "settings.section",
		      id: "web-providers",
		      order: 40,
		      label: () => t("nav"),
		      inject: injected
		    }, WebProvidersSection));
		  });
		}
		
		// ---- end bundle ----
		return module.exports;
	}
});
