/**
 * One-shot demo of the dsh-web-search pipeline: runs the REAL call chain
 * (governor execute hook → HttpSearchProvider → Tavily HTTP → adapter parse →
 * governor post-execute shaping → accounting ledger) and narrates every stage
 * with its intermediate artefact and the source location that produced it.
 *
 *   pnpm demo                         # query defaults to 蓝色大肥鱼
 *   pnpm demo "your query"
 *   pnpm demo --pause                 # wait for Enter between acts (for talks)
 *   pnpm demo --full                  # print full JSON instead of condensed previews
 *
 * Always hits the real Tavily API — there is no offline / mocked mode.
 * Key: TAVILY_API_KEY env, else `web-search-tavily.apiKey` in ~/.dsh/settings.yaml
 * (the same two places the plugin's credential resolver looks).
 * Artefacts of every stage are written to .trace/demo/.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { HttpSearchProvider, Config as HttpConfig } from "../packages/search-http/lib/index.js";
import { getAdapter, catalog } from "../packages/search-http/lib/adapter.js";
import { applyWith, Config as GovernorConfig, ledgerOf } from "../packages/search-governor/lib/index.js";
import { resolveCaps } from "../packages/search-governor/lib/shape.js";
import { tokenize, jaccard } from "../packages/search-governor/lib/similarity.js";
import { normalizeQuery } from "../packages/search-governor/lib/cache.js";
import { estimateTokens } from "../packages/shared/src/text.js";

// ───────────────────────────── CLI ─────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const QUERY = positional[0] ?? "蓝色大肥鱼";
const PAUSE = flags.has("--pause");
const FULL = flags.has("--full");
const OUT = resolve(".trace/demo");
mkdirSync(OUT, { recursive: true });

// ───────────────────────────── pretty ─────────────────────────────
const color = !("NO_COLOR" in process.env) && stdout.isTTY;
const c = {
	bold: (s) => (color ? `\x1b[1m${s}\x1b[0m` : s),
	dim: (s) => (color ? `\x1b[2m${s}\x1b[0m` : s),
	cyan: (s) => (color ? `\x1b[36m${s}\x1b[0m` : s),
	green: (s) => (color ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s) => (color ? `\x1b[33m${s}\x1b[0m` : s),
	magenta: (s) => (color ? `\x1b[35m${s}\x1b[0m` : s),
};
const W = 80;
let act = 0;
const rl = PAUSE ? createInterface({ input: stdin, output: stdout }) : undefined;

async function scene(title, explain) {
	act++;
	console.log(`\n${c.cyan("═".repeat(W))}`);
	console.log(c.bold(c.cyan(` ACT ${act}  ${title}`)));
	console.log(c.cyan("═".repeat(W)));
	if (explain) console.log(c.dim(explain.trim().split("\n").map((l) => `   ${l.trim()}`).join("\n")));
	if (rl) await rl.question(c.dim("   ⏎ continue… "));
}
function src(where, what) {
	console.log(`   ${c.magenta("📄")} ${c.magenta(where)}${what ? c.dim(`  — ${what}`) : ""}`);
}
function note(line) {
	console.log(`   ${c.yellow("▸")} ${line}`);
}
function ok(line) {
	console.log(`   ${c.green("✔")} ${line}`);
}
function sizeOf(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return `${text.length} chars ≈ ${estimateTokens(text)} tokens`;
}
/** Condensed view: long strings cut to `max` with a marker so the shape is visible without flooding the screen. */
function condense(value, max = 160) {
	if (FULL) return value;
	if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… [${value.length} chars]` : value;
	if (Array.isArray(value)) return value.map((v) => condense(v, max));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, condense(v, max)]));
	return value;
}
function show(label, value, file) {
	const pretty = JSON.stringify(condense(value), null, 2);
	console.log(`\n   ${c.bold(label)}  ${c.dim(`(${sizeOf(value)})`)}`);
	console.log(pretty.split("\n").map((l) => `   ${l}`).join("\n"));
	if (file) {
		const path = join(OUT, file);
		writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
		console.log(c.dim(`   ↳ full artefact: ${path}`));
	}
}

// ───────────────────────────── key ─────────────────────────────
function resolveKey() {
	if (process.env.TAVILY_API_KEY) return { key: process.env.TAVILY_API_KEY, from: "launch environment (TAVILY_API_KEY)" };
	const settings = join(homedir(), ".dsh", "settings.yaml");
	if (existsSync(settings)) {
		const m = readFileSync(settings, "utf8").match(/web-search-tavily:\s*\r?\n\s*apiKey:\s*(\S+)/u);
		if (m) return { key: m[1], from: "~/.dsh/settings.yaml → web-search-tavily.apiKey" };
	}
	return { key: undefined, from: "none" };
}

// ═════════════════════════════ ACT 0: map ═════════════════════════════
console.log(c.bold(`\n dsh-web-search · live pipeline demo`));
console.log(c.dim(` query = "${QUERY}"   live Tavily   artefacts → ${OUT}\n`));

await scene("The map — who calls whom", `
	A model calls the official DSH tool web_search({ query }). Two of our plugins sit on that path:
	• search-governor  hooks the host tool bus (tools/execute + tools/post-execute) — budget, cache, dedupe, shaping.
	• search-http      is the provider behind ctx.web.search(); the tavily adapter shapes request / response.
	Everything below runs the real code of those two packages; only the DSH host is replaced by a tiny fake ctx.
`);
console.log(`
   model ──► web_search tool ──► ${c.bold("tools/execute")} ─────────────── governor: cache? near-dup? budget?
                                        │ next()
                                        ▼
                                 ctx.web.search()
                                        │
                                 ${c.bold("HttpSearchProvider.search()")}   search-http/lib/index.js
                                        │  resolve key → adapter.buildRequest → fetchWithTimeout → adapter.parseResponse
                                        ▼
                                 { content, sources[], truncated }         WebSearchResult
                                        │
                                 ${c.bold("tools/post-execute")} ──────────── governor: shapeSearchValue → ledger → log
                                        ▼
                                 model sees the shaped value
`);
src("packages/search-http/lib/index.js", "HttpSearchProvider + Config + resolveOptions");
src("packages/search-http/lib/adapter.js", "adapter registry (tavily / brave / exa / serper / jina / searxng)");
src("packages/search-http/lib/adapters/tavily.js", "buildRequest / parseResponse / describeError");
src("packages/search-governor/lib/index.js", "applyWith: execute arm, post-execute arm, guidance");
src("packages/search-governor/lib/{shape,budget,cache,similarity,ledger}.js", "pure helpers, no I/O");
src("packages/shared/src/{text,http,credentials,settings}.js", "cleanSnippet/truncate/cleanUrl, fetchWithTimeout, key resolution");

// ═════════════════════════════ ACT 1: wiring ═════════════════════════════
await scene("Wiring — what the cordis rows and schemas resolve to", `
	Each package ships a cordis.patch.yml that inserts one row. Config schemas (schemastery) fill defaults,
	so an empty "config: {}" is still a complete, validated object. This is the state before any search.
`);
const httpCfg = new HttpConfig({ backend: "tavily", apiKeyEnv: "TAVILY_API_KEY" });
const govCfg = new GovernorConfig({ activeProvider: "tavily" });
show("row web-search-tavily → HttpConfig (defaults filled)", { backend: httpCfg.backend, apiKeyEnv: httpCfg.apiKeyEnv, baseURL: httpCfg.baseURL, timeoutMs: httpCfg.timeoutMs, maxResults: httpCfg.maxResults, tavily: httpCfg.tavily }, "act1-http-config.json");
show("row web-search-governor → GovernorConfig (defaults filled)", { maxSources: govCfg.maxSources, snippetMaxChars: govCfg.snippetMaxChars, contentMaxChars: govCfg.contentMaxChars, budgetPerSession: govCfg.budgetPerSession, cache: govCfg.cache, nearDuplicate: govCfg.nearDuplicate, nearDuplicateThreshold: govCfg.nearDuplicateThreshold, nearDuplicateMode: govCfg.nearDuplicateMode, providerOverrides: govCfg.providerOverrides, activeProvider: govCfg.activeProvider }, "act1-governor-config.json");
const caps = resolveCaps(govCfg, govCfg.providerOverrides, govCfg.activeProvider);
note(`effective shaping caps for provider "tavily" = ${JSON.stringify(caps)}  ${c.dim("(snippetMaxChars 300 → 800 via providerOverrides.tavily)")}`);
src("packages/search-governor/lib/shape.js:36", "resolveCaps(base, overrides, providerId)");
note(`adapter catalog: ${catalog().map((a) => a.id).join(", ")}`);
src("packages/search-http/lib/adapter.js:60", "adapters registry — provider id === backend name");

// ═════════════════════════════ ACT 2: credential ═════════════════════════════
await scene("Credential — where the key comes from", `
	resolveOptions() builds an apiKeyResolver: literal apiKey → DSH credentials service → launch env.
	The key never appears in logs or session records; recordRequest() only sees { endpoint, backend, query, maxResults }.
`);
const { key, from } = resolveKey();
if (!key) {
	console.error(`\n   ✖ no Tavily key: set TAVILY_API_KEY or web-search-tavily.apiKey in ~/.dsh/settings.yaml`);
	process.exit(1);
}
note(`key source: ${c.bold(from)}  ${c.dim(`(${key.slice(0, 9)}…${key.slice(-4)})`)}`);
src("packages/search-http/lib/index.js:251", "resolveOptions(ctx, config)");
src("packages/search-http/lib/index.js:206", "HttpSearchProvider.apiKey() → WEB_PROVIDER_CREDENTIAL_MISSING when nothing resolves");
src("packages/shared/src/credentials.js", "apiKeyResolver: literal → credentials service → env");

// ═════════════════════════════ build provider + governor ═════════════════════════════
const adapter = getAdapter("tavily");
const requestLog = [];
const provider = new HttpSearchProvider(() => ({
	adapter,
	apiKey: key,
	apiKeyEnv: httpCfg.apiKeyEnv,
	baseURL: httpCfg.baseURL,
	timeoutMs: httpCfg.timeoutMs,
	maxResults: httpCfg.maxResults,
	backend: httpCfg.tavily,
	recordRequest: (r) => requestLog.push(r),
}));

// Tap fetch so the demo can show the wire-level request/response without changing provider code.
const wire = { request: undefined, response: undefined, status: undefined, ms: undefined };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	wire.request = { url: String(url), method: init?.method, redirect: init?.redirect, headers: { ...init?.headers, authorization: "Bearer tvly-***redacted***" }, body: init?.body ? JSON.parse(init.body) : undefined };
	const t0 = performance.now();
	const res = await realFetch(url, init);
	wire.ms = Math.round(performance.now() - t0);
	wire.status = res.status;
	const text = await res.text();
	try { wire.response = JSON.parse(text); } catch { wire.response = text; }
	return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
};

const logs = [];
const listeners = new Map();
const fakeCtx = {
	on(event, fn, opts) { (listeners.get(event) ?? listeners.set(event, []).get(event)).push({ fn, opts }); return () => {}; },
	systemPrompt: { section: (s) => logs.push(`[systemPrompt.section] ${s.name} (order ${s.order})`) },
	logger: { debug: (m) => logs.push(`[debug] ${m}`), info: (m) => logs.push(`[info]  ${m}`), warn: (m) => logs.push(`[warn]  ${m}`) },
	get: () => undefined,
};
const handles = applyWith(fakeCtx, govCfg, { installSettings: () => {} });
const execArm = listeners.get("tools/execute")[0].fn;
const postArm = listeners.get("tools/post-execute")[0].fn;
const SESSION = "demo-session";
const execOf = (query) => ({ name: "web_search", arguments: { query }, callId: `c${Date.now()}`, parent: undefined, agent: { session: { header: { id: SESSION } } } });
/** What the official tool returns to the bus after the provider answers. */
const toolResultOf = (value) => ({ isError: false, value, content: [{ type: "text", text: "(rendered by official web_search tool)" }], meta: { sources: value.sources, truncated: value.truncated } });
const drain = () => { const out = logs.splice(0); return out; };

// ═════════════════════════════ ACT 3: execute arm ═════════════════════════════
await scene("Governor execute arm — gatekeeping BEFORE the provider is touched", `
	tools/execute runs first. Order: identical-query cache → near-duplicate (Jaccard on stemmed tokens) →
	per-session budget. Only if all three pass does it call next(), i.e. the real provider.
	Mounting also registered a system-prompt guidance section (ACT 0 of the model's life).
`);
drain().forEach((l) => console.log(`   ${c.dim(l)}`));
note(`cache lookup key = normalizeQuery("${QUERY}") = "${normalizeQuery(QUERY)}"`);
note(`budget before: ${JSON.stringify(handles.budget.peek(SESSION))}  ·  history: ${JSON.stringify(handles.history.list(SESSION))}`);
src("packages/search-governor/lib/index.js:228", "ctx.on('tools/execute', …): cache.get → findNearDuplicate → budget.consume → history.push → next()");
src("packages/search-governor/lib/cache.js", "QueryCache / normalizeQuery");
src("packages/search-governor/lib/budget.js", "SessionBudget.consume()");

// ═════════════════════════════ ACT 4: provider ═════════════════════════════
await scene("Provider — HttpSearchProvider.search() → Tavily", `
	next() lands in ctx.web.search(), which is our provider. It resolves the key, lets the adapter build the
	request, records a redacted session event, fetches with timeout + redirect:'error', then maps the body.
`);
let rawResult;
let providerError;
const t0 = performance.now();
const execResult = await execArm(execOf(QUERY), async () => {
	try {
		rawResult = await provider.search({ query: QUERY, maxResults: httpCfg.maxResults });
		return toolResultOf(rawResult);
	} catch (error) {
		providerError = error;
		return { isError: true, content: [{ type: "text", text: String(error.message) }] };
	}
});
const totalMs = Math.round(performance.now() - t0);
const execLogs = drain();

show("4a · adapter.buildRequest() → wire request", wire.request, "act4a-request.json");
src("packages/search-http/lib/adapters/tavily.js:57", "buildRequest(request, options): config → Tavily body, Bearer header");
show("4b · recordRequest() — the only thing written to the session (no key)", requestLog[0]);
src("packages/search-http/lib/index.js:163", "options.recordRequest?.({ endpoint, backend, query, maxResults })");
src("packages/shared/src/http.js:81", "fetchWithTimeout(): caller signal + timeout merged into one AbortSignal");

if (providerError) {
	console.log(`\n   ${c.yellow("✖")} provider threw ${c.bold(providerError.name)} code=${c.bold(providerError.code)}: ${providerError.message}`);
	if (wire.status !== undefined) console.log(`   HTTP ${wire.status} in ${wire.ms} ms`);
	if (wire.response !== undefined) show("vendor error body", wire.response);
	src("packages/search-http/lib/adapters/tavily.js:119", "describeError(status, json)");
	src("packages/search-http/lib/index.js:169", "timeout / abort / network → WebError mapping");
	globalThis.fetch = realFetch;
	rl?.close();
	process.exit(2);
}

ok(`HTTP ${wire.status} in ${wire.ms} ms  ·  whole execute→provider round trip ${totalMs} ms`);
show("4c · raw Tavily body (as received)", wire.response, "act4c-raw-response.json");
note(`Tavily extras we will NOT forward: ${["images", "follow_up_questions", "response_time", "request_id"].filter((k) => k in (wire.response ?? {})).join(", ")}; per result: score, raw_content, id`);
if (Array.isArray(wire.response?.results)) {
	console.log(`\n   ${c.bold("score ladder")} ${c.dim("(Tavily relevance, descending — dropped by parseResponse, order kept)")}`);
	wire.response.results.forEach((r, i) => console.log(`     #${i + 1} ${String(r.score).padEnd(11)} ${(r.content ?? "").length.toString().padStart(5)} chars  ${r.url}`));
}

// ═════════════════════════════ ACT 5: parse ═════════════════════════════
await scene("Adapter parse — vendor JSON → WebSearchResult", `
	parseResponse() is the normalisation boundary: whatever the backend, downstream sees
	{ content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }.
	answer→content · results[].content→snippet (cleanSnippet: collapse whitespace, strip HTML entities) ·
	published_date→publishedAt · dedupe by url · cap at maxResults.
`);
show("5 · WebSearchResult (output of provider.search())", rawResult, "act5-websearchresult.json");
src("packages/search-http/lib/adapters/tavily.js:90", "parseResponse(json, request, { maxResults })");
src("packages/shared/src/text.js:91", "cleanSnippet()  ·  :71 dedupeBy()");
if (Array.isArray(wire.response?.results)) {
	const before = JSON.stringify(wire.response).length;
	const after = JSON.stringify(rawResult).length;
	note(`${before} → ${after} chars: metadata dropped + whitespace collapsed; ${c.bold("no information truncated yet")}`);
	wire.response.results.slice(0, rawResult.sources.length).forEach((r, i) => {
		const s = rawResult.sources[i];
		console.log(`     #${i + 1} content ${String((r.content ?? "").length).padStart(5)} → snippet ${String((s.snippet ?? "").length).padStart(5)} chars${r.url !== s.url ? `  url normalised` : ""}`);
	});
}

// ═════════════════════════════ ACT 6: post-execute ═════════════════════════════
await scene("Governor post-execute arm — shaping what the model actually sees", `
	tools/post-execute runs with { prepend: true } so it sees the official tool's decision first, then
	returns an 'accept' with a replacement value. shapeSearchValue: cleanUrl (strip utm_* etc.) → dedupe →
	truncate snippets to the per-provider cap → cap answer → cap source count. Then ledger + one info log line.
`);
const decision = await postArm(execOf(QUERY), execResult, async () => ({ kind: "accept" }));
const postLogs = drain();
show("6 · shaped value (replacement returned to the tool bus)", decision.value, "act6-shaped.json");
src("packages/search-governor/lib/index.js:301", "ctx.on('tools/post-execute', …, { prepend: true })");
src("packages/search-governor/lib/shape.js:67", "shapeSearchValue(value, caps)");
src("packages/shared/src/text.js:20", "truncate()  ·  :39 cleanUrl()");
console.log(`\n   ${c.bold("per-source snippet length  raw → parsed → shaped")}`);
decision.value.sources.forEach((s, i) => {
	const r = wire.response?.results?.[i];
	const p = rawResult.sources[i];
	console.log(`     #${i + 1} ${String((r?.content ?? "").length).padStart(5)} → ${String((p?.snippet ?? "").length).padStart(5)} → ${String((s.snippet ?? "").length).padStart(5)}${(s.snippet ?? "").endsWith("…") ? c.dim("  (truncated)") : ""}  ${s.title ?? s.url}`);
});
console.log(`\n   ${c.bold("governor log lines")}`);
[...execLogs, ...postLogs].forEach((l) => console.log(`   ${c.dim(l)}`));
const totals = { raw: sizeOf(wire.response ?? {}), parsed: sizeOf(rawResult), shaped: sizeOf(decision.value) };
ok(`context cost: raw ${totals.raw}  →  parsed ${totals.parsed}  →  shaped ${c.bold(totals.shaped)}`);

// ═════════════════════════════ ACT 7: second & third call ═════════════════════════════
await scene("Same session, again — cache hit and near-duplicate, with ZERO provider calls", `
	Call 2: the identical query → served from QueryCache; next() is never invoked.
	Call 3: a rephrased query → Jaccard over stemmed tokens ≥ 0.5 → flagged; in 'notice' mode the provider
	would still run and a one-line note is prepended. We stub next() here to keep the network quiet.
`);
let providerCalls = 0;
const r2 = await execArm(execOf(QUERY), async () => { providerCalls++; return toolResultOf(rawResult); });
const l2 = drain();
ok(`call 2 "${QUERY}": provider calls = ${c.bold(providerCalls)} · meta.governor = ${JSON.stringify(r2.meta?.governor)}`);
l2.forEach((l) => console.log(`   ${c.dim(l)}`));

const rephrased = `${QUERY} 是什么 梗`;
const tA = tokenize(QUERY); const tB = tokenize(rephrased);
note(`tokenize("${QUERY}") = ${JSON.stringify(tA)}   tokenize("${rephrased}") = ${JSON.stringify(tB)}   jaccard = ${jaccard(tA, tB).toFixed(2)}`);
src("packages/search-governor/lib/similarity.js:36", "tokenize(): lowercase → strip punctuation → stop-words → stem  ·  :53 jaccard()");
const r3 = await execArm(execOf(rephrased), async () => { providerCalls++; return toolResultOf(rawResult); });
const d3 = await postArm(execOf(rephrased), r3, async () => ({ kind: "accept" }));
const l3 = drain();
ok(`call 3 "${rephrased}": provider calls so far = ${c.bold(providerCalls)} (stubbed) · content now starts with:`);
console.log(`     ${c.yellow(String(d3.value.content).split("\n")[0])}`);
l3.forEach((l) => console.log(`   ${c.dim(l)}`));
note(`budget now: ${JSON.stringify(handles.budget.peek(SESSION))}  ·  after ${govCfg.budgetPerSession} the arm returns a notice instead of calling next()`);

// ═════════════════════════════ ACT 8: errors ═════════════════════════════
await scene("Failure modes — every vendor status becomes one WebError the host understands", `
	HttpSearchProvider maps HTTP / timeout / redirect / abort to WebError codes; the adapter only writes the message.
`);
console.log(`   ${c.bold("status  → code                      message")}`);
for (const [status, body] of [[401, { detail: { error: "Invalid API key" } }], [429, { detail: "Rate limit" }], [432, undefined], [500, { message: "upstream" }]]) {
	console.log(`   ${String(status).padEnd(7)} → WEB_PROVIDER_ERROR         ${adapter.describeError(status, body, { apiKeyEnv: "TAVILY_API_KEY" })}`);
}
console.log(`   ${"no key".padEnd(7)} → WEB_PROVIDER_CREDENTIAL_MISSING  (index.js:219)`);
console.log(`   ${"timeout".padEnd(7)} → WEB_PROVIDER_ERROR         "tavily search timed out after 20000 ms …" (index.js:175)`);
console.log(`   ${"abort".padEnd(7)} → WEB_ABORTED                caller's AbortSignal (index.js:173)`);
src("packages/search-http/lib/adapters/tavily.js:119", "describeError(status, json, { apiKeyEnv })");
src("packages/search-http/lib/index.js:169", "fetch error → timeout / abort / network mapping");

// ═════════════════════════════ ACT 9: ledger ═════════════════════════════
await scene("Accounting — the per-session ledger", `
	Every governed search adds raw vs shaped tokens; cache hits, near-duplicates and budget blocks are counted too.
	ledgerOf(sessionKey) is what a dashboard or the GUI settings section would read.
`);
show("ledgerOf('demo-session')", ledgerOf(SESSION), "act9-ledger.json");
src("packages/search-governor/lib/ledger.js", "SessionLedger");

globalThis.fetch = realFetch;
rl?.close();
console.log(`\n${c.green("═".repeat(W))}`);
console.log(c.bold(c.green(` done · ${act} acts · artefacts in ${OUT}`)));
console.log(c.green("═".repeat(W)) + "\n");
