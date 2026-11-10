/**
 * Manual smoke test — hits the REAL network. Not part of `pnpm test`.
 *
 *   TAVILY_API_KEY=tvly-... node scripts/smoke.js [query] [url]
 *
 * Exercises the Tavily provider and the readability fetch provider directly
 * (no DSH runtime), then runs the governor's shaping on the search result so
 * you can see the before/after sizes.
 */
import { HttpSearchProvider } from "../packages/search-http/lib/index.js";
import { getAdapter } from "../packages/search-http/lib/adapter.js";
import { ReadabilityFetchProvider } from "../packages/fetch-readability/lib/index.js";
import { shapeSearchValue } from "../packages/search-governor/lib/shape.js";
import { estimateTokens } from "../packages/shared/src/text.js";

const query = process.argv[2] ?? "DeepSeek Harness cordis plugin";
const url = process.argv[3] ?? "https://en.wikipedia.org/wiki/Readability";

function size(label, text) {
	console.log(`${label}: ${text.length} chars ≈ ${estimateTokens(text)} tokens`);
}

async function smokeSearch() {
	const key = process.env.TAVILY_API_KEY;
	if (!key) {
		console.log("[search] TAVILY_API_KEY not set — skipping");
		return;
	}
	const adapter = getAdapter("tavily");
	const provider = new HttpSearchProvider(() => ({
		adapter,
		apiKey: key,
		apiKeyEnv: adapter.defaultApiKeyEnv,
		baseURL: adapter.defaultBaseURL,
		timeoutMs: 20_000,
		maxResults: 5,
		backend: { searchDepth: "basic", includeAnswer: true, includeRawContent: false, topic: "general", includeDomains: [], excludeDomains: [] },
	}));
	console.log(`[search] "${query}" via ${provider.id}`);
	const raw = await provider.search({ query, maxResults: 5 });
	const rawText = JSON.stringify(raw);
	size("[search] raw", rawText);
	const { value, stats } = shapeSearchValue(raw, { maxSources: 5, snippetMaxChars: 800, contentMaxChars: 1500, stripTrackingParams: true });
	size("[search] shaped", JSON.stringify(value));
	console.log("[search] stats", stats);
	if (value.content) console.log(`[search] answer: ${value.content}`);
	for (const s of value.sources) console.log(`  - ${s.title ?? ""} ${s.url}\n      ${(s.snippet ?? "").slice(0, 200).replace(/\s+/g, " ")}`);
}

async function smokeFetch() {
	const provider = new ReadabilityFetchProvider(() => ({
		maxOutputChars: 20_000,
		maxBodyBytes: 5 * 1024 * 1024,
		timeoutMs: 20_000,
		maxRedirects: 5,
		userAgent: "dsh-web-fetch-readability/smoke",
		acceptLanguage: "en-US,en;q=0.8",
		allowPrivate: false,
		readability: true,
		allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain", "application/json", "application/xml", "text/xml"],
	}));
	console.log(`[fetch] ${url}`);
	const result = await provider.fetch({ url });
	console.log(`[fetch] HTTP ${result.statusCode} kind=${result.body.kind} truncated=${result.truncated} final=${result.url}`);
	size("[fetch] body", result.body.content);
	console.log(result.body.content.slice(0, 400).replace(/\s+/g, " "), "…");
	try {
		await provider.fetch({ url: "http://127.0.0.1:3080/" });
		console.log("[fetch] !! loopback was NOT blocked");
	} catch (error) {
		console.log(`[fetch] loopback blocked as expected: ${error.code ?? error.name}`);
	}
}

await smokeSearch().catch((e) => console.error("[search] failed:", e));
await smokeFetch().catch((e) => console.error("[fetch] failed:", e));
