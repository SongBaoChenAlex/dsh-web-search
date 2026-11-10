/**
 * Run one URL through the three fetch providers shipped in this repo and print
 * what the model would see from each. Standalone: no DSH host needed.
 *
 *   node scripts/fetch-compare.js <url> [--full] [--no-tavily]
 *
 * TAVILY_API_KEY is read from the environment, falling back to
 * ~/.dsh/settings.yaml (`web-search-tavily: apiKey:`). Tavily extract costs
 * credits; pass --no-tavily to skip it (composite then has only one member).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReadabilityFetchProvider } from "../packages/fetch-readability/lib/index.js";
import { TavilyExtractFetchProvider } from "../packages/tavily-tools/lib/extract.js";
import { createTavilyClient } from "../packages/tavily-tools/lib/tavily-client.js";
import { CompositeFetchProvider, textLengthOf } from "../packages/fetch-composite/lib/index.js";
import { estimateTokens } from "../packages/shared/src/text.js";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const full = args.includes("--full");
const noTavily = args.includes("--no-tavily");
if (!url) {
	console.error("usage: node scripts/fetch-compare.js <url> [--full] [--no-tavily]");
	process.exit(2);
}

function tavilyKey() {
	if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
	try {
		const yaml = readFileSync(join(homedir(), ".dsh", "settings.yaml"), "utf8");
		return /apiKey:\s*(tvly-\S+)/u.exec(yaml)?.[1];
	} catch {
		return undefined;
	}
}

const readability = new ReadabilityFetchProvider(() => ({}));
const providers = new Map([[readability.id, readability]]);
if (!noTavily) {
	const key = tavilyKey();
	if (key) {
		const client = createTavilyClient({ resolveOptions: () => ({ apiKey: key }) });
		const tavily = new TavilyExtractFetchProvider(client, () => ({}));
		providers.set(tavily.id, tavily);
	} else {
		console.error("(no TAVILY_API_KEY found — skipping tavily-extract)");
	}
}
const web = { fetchProviders: providers };
const composite = new CompositeFetchProvider(web, () => ({}));
providers.set(composite.id, composite);

function preview(text, n = 900) {
	const t = text.replace(/\s+\n/gu, "\n").trim();
	return full || t.length <= n ? t : `${t.slice(0, n)}\n… (${t.length - n} more chars)`;
}

async function run(provider) {
	const started = Date.now();
	try {
		const result = await provider.fetch({ url }, AbortSignal.timeout(90_000));
		const ms = Date.now() - started;
		const content = result.body.content;
		console.log(`\n${"═".repeat(78)}\n▶ ${provider.id}   status=${result.statusCode}  kind=${result.body.kind}  ${ms} ms`);
		console.log(`  raw chars=${content.length}  visible text chars=${textLengthOf(result)}  ≈${estimateTokens(content)} tokens  truncated=${result.truncated}`);
		console.log("─".repeat(78));
		console.log(preview(content));
	} catch (error) {
		console.log(`\n${"═".repeat(78)}\n▶ ${provider.id}   FAILED after ${Date.now() - started} ms`);
		console.log(`  ${error?.code ?? error?.name ?? "Error"}: ${error?.message ?? error}`);
	}
}

console.log(`URL: ${url}\nproviders: ${[...providers.keys()].join(", ")}`);
for (const id of ["readability-http", "tavily-extract", "composite"]) {
	const p = providers.get(id);
	if (p) await run(p);
}
