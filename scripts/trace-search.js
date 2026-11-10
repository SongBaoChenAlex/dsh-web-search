/**
 * Step-by-step trace of one Tavily web_search — hits the REAL network.
 *
 *   TAVILY_API_KEY=tvly-... node scripts/trace-search.js [query] [outDir]
 *
 * Prints, in order:
 *   1. the request the adapter builds (headers redacted)
 *   2. the raw HTTP response body from Tavily
 *   3. the adapter's parseResponse output (the WebSearchResult the seam sees)
 *   4. the governor's shaped value (what the model finally sees) + stats
 * and writes every stage to <outDir>/step-N-*.json (default: .trace/).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../packages/search-http/lib/adapter.js";
import { shapeSearchValue } from "../packages/search-governor/lib/shape.js";
import { estimateTokens } from "../packages/shared/src/text.js";

const query = process.argv[2] ?? "蓝色大肥鱼";
const outDir = process.argv[3] ?? ".trace";
const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) {
	console.error("TAVILY_API_KEY not set");
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const adapter = getAdapter("tavily");
const options = {
	adapter,
	apiKey,
	apiKeyEnv: adapter.defaultApiKeyEnv,
	baseURL: adapter.defaultBaseURL,
	timeoutMs: 20_000,
	maxResults: 5,
	userAgent: "dsh-web-search-http/trace",
	backend: { searchDepth: "basic", includeAnswer: true, includeRawContent: false, topic: "general", includeDomains: [], excludeDomains: [] },
};
const request = { query, maxResults: 5 };

function banner(n, title) {
	console.log(`\n${"=".repeat(78)}\n STEP ${n}: ${title}\n${"=".repeat(78)}`);
}
function dump(n, name, value) {
	const file = join(outDir, `step-${n}-${name}.json`);
	const text = JSON.stringify(value, null, 2);
	writeFileSync(file, text, "utf8");
	console.log(text);
	console.log(`-- ${text.length} chars ≈ ${estimateTokens(text)} tokens  → ${file}`);
}

// ---- 1. build request --------------------------------------------------------
banner(1, "adapter.buildRequest() — what we send to Tavily");
const { url, init } = adapter.buildRequest(request, options);
dump(1, "request", {
	url,
	method: init.method,
	redirect: init.redirect,
	headers: { ...init.headers, authorization: "Bearer tvly-***redacted***" },
	body: JSON.parse(init.body),
});

// ---- 2. raw HTTP response ----------------------------------------------------
banner(2, "raw HTTP response from Tavily");
const t0 = performance.now();
const res = await fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
const elapsed = Math.round(performance.now() - t0);
const json = await res.json();
console.log(`HTTP ${res.status} in ${elapsed} ms, content-type=${res.headers.get("content-type")}`);
if (!res.ok) {
	console.error(adapter.describeError(res.status, json, { apiKeyEnv: options.apiKeyEnv }));
	process.exit(2);
}
dump(2, "raw-response", json);

// ---- 3. parsed WebSearchResult ----------------------------------------------
banner(3, "adapter.parseResponse() — WebSearchResult handed to ctx.web.search()");
const parsed = adapter.parseResponse(json, request, { maxResults: options.maxResults });
dump(3, "parsed", parsed);
console.log("\nfield mapping per result: answer→content, results[].content→snippet, published_date→publishedAt; score/raw_content dropped; deduped by url");

// ---- 4. governor shaping -----------------------------------------------------
banner(4, "governor shapeSearchValue() — what the model finally sees");
const caps = { maxSources: 5, snippetMaxChars: 800, contentMaxChars: 1500, stripTrackingParams: true };
console.log("caps:", caps);
const { value: shaped, stats } = shapeSearchValue(parsed, caps);
dump(4, "shaped", shaped);
console.log("\nstats:", stats);

// ---- per-source diff ---------------------------------------------------------
banner(5, "per-source before/after summary");
for (let i = 0; i < shaped.sources.length; i++) {
	const r = json.results[i];
	const p = parsed.sources[i];
	const s = shaped.sources[i];
	console.log(`#${i + 1} ${s.title ?? "(no title)"}`);
	console.log(`   url         : ${s.url}${r.url !== s.url ? `   (raw: ${r.url})` : ""}`);
	console.log(`   score       : ${r.score} (dropped)`);
	console.log(`   content     : raw ${r.content?.length ?? 0} → parsed snippet ${p.snippet?.length ?? 0} → shaped ${s.snippet?.length ?? 0} chars`);
	if (r.published_date) console.log(`   publishedAt : ${s.publishedAt}`);
}
console.log(`\nanswer: raw ${json.answer?.length ?? 0} → shaped ${shaped.content?.length ?? 0} chars`);
console.log(`total : ${stats.charsBefore} → ${stats.charsAfter} chars, ≈${stats.tokensBefore} → ${stats.tokensAfter} tokens`);
