/**
 * Pure form model for the governor settings page: which fields exist, how a
 * stored value becomes draft text, how draft text becomes a write, and which
 * writes a save would issue. No React, no DSH imports — unit-testable as is.
 *
 * Mirrors the Host `Config` schema in `lib/index.js` field by field; the Host
 * stays the authority (its schemastery validation rejects anything the client
 * let through), the client only pre-checks what it can.
 * @module @baoson/dsh-web-search-governor/client/form
 */

/** Settings namespace this page edits (= `SETTINGS_NAMESPACE` on the host). */
export const NAMESPACE = "web-search-governor";

/**
 * @typedef {"int"|"ratio"|"bool"|"enum"|"text"|"textarea"} FieldKind
 * @typedef {{ key: string, kind: FieldKind, group: "budget"|"shaping"|"repeat"|"misc", options?: string[], restart?: boolean }} FieldSpec
 */

/** @type {FieldSpec[]} display order within each group follows this array */
export const FIELDS = Object.freeze([
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
	{ key: "logAccounting", kind: "bool", group: "misc" },
]);

/** Group order on the page. */
export const GROUPS = Object.freeze(["budget", "shaping", "repeat", "misc"]);

/** @param {string} key */
export function specOf(key) {
	const spec = FIELDS.find((f) => f.key === key);
	if (spec === undefined) throw new Error(`governor form has no field ${key}`);
	return spec;
}

/**
 * Stored value → draft text.
 * @param {FieldSpec} spec
 * @param {unknown} value
 */
export function format(spec, value) {
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

/**
 * Draft text → write intent. `undefined` means the draft is invalid and blocks
 * the save; `{ kind: "clear" }` removes the user override so the field falls
 * back to the composition row / schema default.
 * @param {FieldSpec} spec
 * @param {string} text
 * @returns {{ kind: "set", value: unknown } | { kind: "clear" } | undefined}
 */
export function parse(spec, text) {
	const trimmed = String(text ?? "").trim();
	if (trimmed === "") return { kind: "clear" };
	switch (spec.kind) {
		case "bool":
			if (trimmed === "true") return { kind: "set", value: true };
			if (trimmed === "false") return { kind: "set", value: false };
			return undefined;
		case "int": {
			if (!/^\d+$/u.test(trimmed)) return undefined;
			const n = Number(trimmed);
			return Number.isSafeInteger(n) ? { kind: "set", value: n } : undefined;
		}
		case "ratio": {
			const n = Number(trimmed);
			return Number.isFinite(n) && n >= 0 && n <= 1 ? { kind: "set", value: n } : undefined;
		}
		case "enum":
			return spec.options?.includes(trimmed) ? { kind: "set", value: trimmed } : undefined;
		case "textarea":
			// Keep the author's internal whitespace; only a blank draft clears.
			return { kind: "set", value: String(text) };
		default:
			return { kind: "set", value: trimmed };
	}
}

/**
 * @typedef {{ status: string, value?: any, base?: any, user?: any, writable?: boolean }} ScopeSnapshot
 * @typedef {{ text: string, clear?: boolean }} Draft
 * @typedef {Record<string, Draft>} Drafts
 */

/** Whether the user layer carries `key` (= the field is overridden). */
export function stored(snapshot, key) {
	const user = snapshot?.user;
	return user !== undefined && user !== null && Object.hasOwn(user, key);
}

/**
 * The state one control renders from.
 * @param {FieldSpec} spec
 * @param {ScopeSnapshot} snapshot
 * @param {Drafts} drafts
 */
export function fieldState(spec, snapshot, drafts) {
	const draft = drafts[spec.key];
	const effective = snapshot?.value?.[spec.key];
	const fallback = snapshot?.base?.[spec.key];
	if (draft === undefined) {
		return { text: format(spec, effective), overridden: stored(snapshot, spec.key), invalid: false, dirty: false, effective, fallback };
	}
	const write = draft.clear ? { kind: "clear" } : parse(spec, draft.text);
	return {
		text: draft.text,
		overridden: write?.kind === "set",
		invalid: write === undefined,
		dirty: true,
		effective,
		fallback,
	};
}

/**
 * Every write a save would issue, in staging order. An entry with `op:
 * undefined` is an invalid draft (blocks the save). Unchanged drafts and
 * clears of fields that were never stored produce nothing.
 * @param {ScopeSnapshot} snapshot
 * @param {Drafts} drafts
 * @returns {Array<{ field: string, op: "set" | "unset" | undefined, value?: unknown }>}
 */
export function plan(snapshot, drafts) {
	const out = [];
	for (const [key, draft] of Object.entries(drafts)) {
		const spec = specOf(key);
		if (draft.clear) {
			if (stored(snapshot, key)) out.push({ field: key, op: "unset" });
			continue;
		}
		if (draft.text === format(spec, snapshot?.value?.[key])) continue;
		const write = parse(spec, draft.text);
		if (write === undefined) out.push({ field: key, op: undefined });
		else if (write.kind === "clear") {
			if (stored(snapshot, key)) out.push({ field: key, op: "unset" });
		} else out.push({ field: key, op: "set", value: write.value });
	}
	return out;
}

/** Summary flags for the footer (dirty / invalid). */
export function shell(snapshot, drafts) {
	const writes = plan(snapshot, drafts);
	return {
		available: snapshot?.status === "ready",
		writable: snapshot?.writable === true,
		dirty: writes.length > 0,
		invalid: writes.some((w) => w.op === undefined),
	};
}

/**
 * Human-readable one-liner of the token budget for the header, e.g.
 * "5 sources · 300 chars/snippet · 10 searches/session".
 * @param {any} value resolved section value
 */
export function summary(value) {
	if (value === undefined || value === null) return "";
	const n = (v, inf) => (typeof v === "number" ? (v === 0 ? inf : String(v)) : "?");
	return `${n(value.maxSources, "∞")} sources · ${n(value.snippetMaxChars, "∞")} chars/snippet · ${n(value.budgetPerSession, "∞")} searches/session`;
}
