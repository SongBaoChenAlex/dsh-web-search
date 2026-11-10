import { describe, it, expect } from "vitest";
import { FIELDS, GROUPS, NAMESPACE, fieldState, format, parse, plan, shell, specOf, summary } from "../src/client/form.js";
import { Config, SETTINGS_NAMESPACE } from "../lib/index.js";

describe("client form model", () => {
	it("mirrors the host Config schema field by field", () => {
		expect(NAMESPACE).toBe(SETTINGS_NAMESPACE);
		const hostKeys = Object.keys(Config.dict ?? {}).filter((k) => k !== "providerOverrides");
		const formKeys = FIELDS.map((f) => f.key);
		expect(formKeys.sort()).toEqual(hostKeys.sort());
		for (const f of FIELDS) expect(GROUPS).toContain(f.group);
	});

	it("parses and formats each field kind", () => {
		const int = specOf("maxSources");
		expect(parse(int, "5")).toEqual({ kind: "set", value: 5 });
		expect(parse(int, " 0 ")).toEqual({ kind: "set", value: 0 });
		expect(parse(int, "")).toEqual({ kind: "clear" });
		expect(parse(int, "-1")).toBeUndefined();
		expect(parse(int, "1.5")).toBeUndefined();
		expect(format(int, 7)).toBe("7");
		expect(format(int, undefined)).toBe("");

		const ratio = specOf("nearDuplicateThreshold");
		expect(parse(ratio, "0.6")).toEqual({ kind: "set", value: 0.6 });
		expect(parse(ratio, "1.2")).toBeUndefined();

		const bool = specOf("cache");
		expect(parse(bool, "true")).toEqual({ kind: "set", value: true });
		expect(parse(bool, "false")).toEqual({ kind: "set", value: false });
		expect(parse(bool, "yes")).toBeUndefined();
		expect(format(bool, false)).toBe("false");

		const mode = specOf("nearDuplicateMode");
		expect(parse(mode, "block")).toEqual({ kind: "set", value: "block" });
		expect(parse(mode, "nope")).toBeUndefined();

		const notice = specOf("budgetNotice");
		expect(parse(notice, "  two  spaces ")).toEqual({ kind: "set", value: "  two  spaces " });
		expect(parse(notice, "   ")).toEqual({ kind: "clear" });

		const text = specOf("activeProvider");
		expect(parse(text, " tavily ")).toEqual({ kind: "set", value: "tavily" });
	});

	it("plans only the writes a save needs", () => {
		const snapshot = {
			status: "ready",
			writable: true,
			value: { maxSources: 5, snippetMaxChars: 800, cache: true, nearDuplicateMode: "notice" },
			base: { maxSources: 5 },
			user: { snippetMaxChars: 800 },
		};
		// unchanged draft → nothing
		expect(plan(snapshot, { maxSources: { text: "5" } })).toEqual([]);
		// changed → set
		expect(plan(snapshot, { maxSources: { text: "3" } })).toEqual([{ field: "maxSources", op: "set", value: 3 }]);
		// clear a stored override → unset
		expect(plan(snapshot, { snippetMaxChars: { text: "", clear: true } })).toEqual([{ field: "snippetMaxChars", op: "unset" }]);
		// clear a field never stored → nothing
		expect(plan(snapshot, { maxSources: { text: "", clear: true } })).toEqual([]);
		// emptying a stored field's text is also an unset
		expect(plan(snapshot, { snippetMaxChars: { text: "" } })).toEqual([{ field: "snippetMaxChars", op: "unset" }]);
		// invalid → op undefined blocks
		const p = plan(snapshot, { maxSources: { text: "abc" } });
		expect(p).toEqual([{ field: "maxSources", op: undefined }]);
		expect(shell(snapshot, { maxSources: { text: "abc" } })).toMatchObject({ dirty: true, invalid: true, available: true, writable: true });
		expect(shell(snapshot, {})).toMatchObject({ dirty: false, invalid: false });
	});

	it("reports field state with override and effective value", () => {
		const snapshot = { status: "ready", writable: true, value: { maxSources: 5 }, base: { maxSources: 5 }, user: {} };
		expect(fieldState(specOf("maxSources"), snapshot, {})).toMatchObject({ text: "5", overridden: false, invalid: false, dirty: false, effective: 5 });
		expect(fieldState(specOf("maxSources"), snapshot, { maxSources: { text: "4" } })).toMatchObject({ text: "4", overridden: true, dirty: true });
		expect(fieldState(specOf("maxSources"), snapshot, { maxSources: { text: "x" } })).toMatchObject({ invalid: true });
		expect(fieldState(specOf("maxSources"), { ...snapshot, user: { maxSources: 5 } }, {})).toMatchObject({ overridden: true });
	});

	it("summarizes the caps", () => {
		expect(summary({ maxSources: 5, snippetMaxChars: 300, budgetPerSession: 10 })).toBe("5 sources · 300 chars/snippet · 10 searches/session");
		expect(summary({ maxSources: 0, snippetMaxChars: 0, budgetPerSession: 0 })).toBe("∞ sources · ∞ chars/snippet · ∞ searches/session");
		expect(summary(undefined)).toBe("");
	});
});
