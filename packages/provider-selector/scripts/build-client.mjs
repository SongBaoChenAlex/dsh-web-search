/**
 * Bundle `src/client/index.jsx` into `lib/client.js` in the DSH client-plugin
 * module format:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...CJS...; return module.exports; } })
 *
 * esbuild emits a CJS bundle whose remaining `require("...")` calls are
 * exactly the externals below — the seed table the DSH shell `require`
 * can resolve. Everything else (our own sources, the remote descriptor) is
 * inlined.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));

/** Modules the DSH Web shell provides to client plugins (must stay `require`-able, never bundled). */
export const CLIENT_EXTERNALS = [
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-web-react",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-attachment",
	"@deepseek-ai/dsh-client-schema-form",
];

export async function buildClient({ outFile = resolve(pkgRoot, "lib", "client.js"), minify = false } = {}) {
	const result = await build({
		entryPoints: [resolve(pkgRoot, "src", "client", "index.jsx")],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "browser",
		target: "es2022",
		jsx: "automatic",
		minify,
		sourcemap: false,
		legalComments: "none",
		external: CLIENT_EXTERNALS,
		logLevel: "silent",
	});
	const [output] = result.outputFiles;
	const bundle = output.text;

	const wrapped = [
		`window.__ModuleLoader__.load({`,
		`\tid: ${JSON.stringify(pkg.name)},`,
		`\tfactory: (require) => {`,
		`\t\tvar module = { exports: {} };`,
		`\t\tvar exports = module.exports;`,
		`\t\t// ---- esbuild cjs bundle ----`,
		bundle.replace(/^/gmu, "\t\t"),
		`\t\t// ---- end bundle ----`,
		`\t\treturn module.exports;`,
		`\t}`,
		`});`,
		``,
	].join("\n");

	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, wrapped, "utf8");
	return { outFile, bytes: Buffer.byteLength(wrapped, "utf8"), warnings: result.warnings };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const { outFile, bytes, warnings } = await buildClient({ minify: process.argv.includes("--minify") });
	for (const warning of warnings) console.warn(`[esbuild] ${warning.text}`);
	console.log(`built ${outFile} (${bytes} bytes)`);
}
