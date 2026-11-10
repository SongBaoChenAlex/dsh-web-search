import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClient, CLIENT_EXTERNALS } from "../scripts/build-client.mjs";

describe("client bundle", () => {
	it("produces a __ModuleLoader__ module whose only requires are shell-provided", async () => {
		const dir = mkdtempSync(join(tmpdir(), "search-governor-client-"));
		try {
			const { outFile } = await buildClient({ outFile: join(dir, "client.js") });
			const text = readFileSync(outFile, "utf8");

			expect(text.startsWith("window.__ModuleLoader__.load({")).toBe(true);
			expect(text).toContain('id: "@tobedone4byme/dsh-web-search-governor"');
			expect(text).toContain("factory: (require) =>");
			expect(text.trimEnd().endsWith("});")).toBe(true);
			expect(text).not.toMatch(/^\s*import\s/mu);
			expect(text).not.toMatch(/^\s*export\s/mu);

			const specifiers = [...text.matchAll(/\brequire\((["'])([^"']+)\1\)/gu)].map((m) => m[2]);
			expect(specifiers.length).toBeGreaterThan(0);
			for (const specifier of new Set(specifiers)) expect(CLIENT_EXTERNALS).toContain(specifier);

			expect(text).toContain("module.exports = __toCommonJS(");
			expect(text).toMatch(/\bapply\b/u);
			expect(text).toMatch(/\binject\b/u);
			expect(text).toContain("configForms");
			expect(text).toContain("whileServed");
			expect(text).toContain("web-search-governor");
			expect(text).toContain("settings.section");
			expect(text).toContain("--dsw-alias-");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
