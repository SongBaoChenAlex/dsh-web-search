/**
 * Plain-text report renderer for `/web-search-demo`. The UI shows command
 * output in a monospace <pre> block, so this is deliberately not Markdown.
 * @module @tobedone4byme/dsh-web-search-demo-command/report
 */

const W = 78;
const rule = (ch = "─") => ch.repeat(W);

function section(n, title, lines) {
	return [``, rule("═"), ` STEP ${n}  ${title}`, rule("═"), ...lines].join("\n");
}
function src(where, what) {
	return `   📄 ${where}${what ? `  — ${what}` : ""}`;
}
function kv(key, value) {
	return `   ${key.padEnd(16)} ${value}`;
}
function preview(value, max) {
	if (typeof value !== "string") return value;
	return value.length > max ? `${value.slice(0, max)}… [${value.length} chars]` : value;
}
function condense(value, max) {
	if (typeof value === "string") return preview(value, max);
	if (Array.isArray(value)) return value.map((v) => condense(v, max));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, condense(v, max)]));
	return value;
}
function json(value, max, indent = "   ") {
	return JSON.stringify(condense(value, max), null, 2).split("\n").map((l) => indent + l).join("\n");
}
function size(value, estimateTokens) {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	return `${text.length} chars ≈ ${estimateTokens(text)} tokens`;
}
function pad(n, w = 5) {
	return String(n).padStart(w);
}

/**
 * @param {object} r
 * @returns {string}
 */
export function renderReport(r) {
	const { estimateTokens: tok, previewChars: P } = r;
	const out = [];

	out.push(` dsh-web-search · live pipeline report`);
	out.push(` query "${r.query}"  ·  session ${r.sessionId}  ·  ${r.elapsedMs} ms total`);

	// ── 0 map ──────────────────────────────────────────────────────────────
	out.push(section(0, "Call chain (what a model-initiated web_search goes through)", [
		`   model ─► web_search tool ─► tools/execute        governor: cache? near-dup? budget?`,
		`                                   │ next()`,
		`                                   ▼`,
		`                             ctx.web.search()        dsh-web seam selects the provider`,
		`                                   │`,
		`                             HttpSearchProvider.search()`,
		`                                   │ key → adapter.buildRequest → fetchWithTimeout → adapter.parseResponse`,
		`                                   ▼`,
		`                             WebSearchResult { content?, sources[], truncated }`,
		`                                   │`,
		`                             tools/post-execute    governor: shapeSearchValue → ledger → log`,
		`                                   ▼`,
		`                             model sees the shaped value`,
		``,
		`   This command entered at ctx.web.search() (no model, no tools/* hooks), so steps 1–4 are the`,
		`   genuine provider path and step 5 re-runs the governor's pure shaping on the result.`,
		src("packages/search-http/lib/index.js", "HttpSearchProvider, resolveOptions, apply"),
		src("packages/search-http/lib/adapters/<backend>.js", "buildRequest / parseResponse / describeError"),
		src("packages/search-governor/lib/index.js", "applyWith: tools/execute + tools/post-execute arms"),
		src("packages/shared/src/{text,http,credentials,settings,host}.js", "shared helpers"),
	]));

	// ── 1 selection ────────────────────────────────────────────────────────
	const s = r.selection;
	out.push(section(1, "Provider selection — ctx.web picks who answers", [
		kv("registered", s.registered.join(", ") || "(none)"),
		kv("usable now", s.usable.join(", ") || "(none)"),
		kv("configured", s.configured ?? "(not set)"),
		kv("selected", s.selected ?? "(none)"),
		kv("rule", s.rule),
		src("~/.dsh/profiles/<profile>/cordis.patch.yml", "`- id: web  config: { searchProvider: … }`"),
		src("@deepseek-ai/dsh-web", "selection rules: configured → single usable → AMBIGUOUS / UNAVAILABLE"),
		src("packages/search-http/lib/index.js:126", "HttpSearchProvider.available(): parseable baseURL + resolvable key"),
	]));

	// ── 2 request ──────────────────────────────────────────────────────────
	const w = r.wire ?? {};
	out.push(section(2, "Request — credential + adapter.buildRequest() → wire", [
		...(w.request ? [json(w.request, P)] : [`   (no HTTP request was captured — the provider failed before fetch, see errors)`]),
		``,
		`   Key resolution order: literal apiKey → DSH credentials service → launch env → process.env.`,
		`   The key is redacted above and never written to the session.`,
		src("packages/shared/src/credentials.js:29", "apiKeyResolver()"),
		src("packages/search-http/lib/index.js:206", "HttpSearchProvider.apiKey() → WEB_PROVIDER_CREDENTIAL_MISSING"),
		src("packages/search-http/lib/adapters/tavily.js:57", "buildRequest(): config → body, Bearer header, redirect:'error'"),
		src("packages/shared/src/http.js:81", "fetchWithTimeout(): caller signal + timeoutMs merged into one AbortSignal"),
	]));

	// ── 3 session event ────────────────────────────────────────────────────
	const se = r.session;
	out.push(section(3, "Session record — what this search left in the log", [
		kv("events before", String(se.before.totalEvents)),
		kv("events after", String(se.after.totalEvents)),
		...(se.newRequests.length > 0
			? se.newRequests.map((e) => `   web/http-search-request @seq ${e.seq}: ${JSON.stringify({ endpoint: e.endpoint, backend: e.backend, query: e.query, maxResults: e.maxResults })}`)
			: [`   (no web/http-search-request appended — provider is not search-http, or no initiator agent on this ctx)`]),
		kv("model web_search", `${se.after.webSearchCalls} tool/call event(s) in this session so far`),
		src("packages/search-http/lib/index.js:265", "recordRequest → agents.currentInitiator().session.append('web/http-search-request')"),
	]));

	// ── 4 raw + parsed ─────────────────────────────────────────────────────
	if (r.error) {
		out.push(section(4, "Provider error", [
			kv("name", r.error.name ?? "Error"),
			kv("code", r.error.code ?? "(none)"),
			kv("message", r.error.message ?? String(r.error)),
			...(w.status !== undefined ? [kv("HTTP", `${w.status} in ${w.ms} ms`)] : []),
			...(w.response !== undefined ? [``, `   vendor body:`, json(w.response, P)] : []),
			src("packages/search-http/lib/adapters/tavily.js:119", "describeError(status, json)"),
			src("packages/search-http/lib/index.js:169", "timeout / abort / network → WebError mapping"),
		]));
	} else {
		const rawLines = [];
		if (w.status !== undefined) rawLines.push(kv("HTTP", `${w.status} in ${w.ms} ms  (${w.contentType ?? "?"})`));
		if (r.showRawBody && w.response !== undefined) {
			rawLines.push(`   raw vendor body  (${size(w.response, tok)})`);
			rawLines.push(json(w.response, P));
			const results = Array.isArray(w.response?.results) ? w.response.results : undefined;
			if (results) {
				rawLines.push(``, `   relevance ladder (vendor score; dropped downstream, order kept):`);
				results.forEach((x, i) => rawLines.push(`     #${i + 1} ${String(x.score ?? "-").padEnd(11)} ${pad((x.content ?? "").length)} chars  ${x.url}`));
			}
		}
		rawLines.push(``, `   parsed WebSearchResult  (${size(r.result, tok)})`);
		rawLines.push(json(r.result, P));
		rawLines.push(``, `   answer→content · results[].content→snippet (whitespace collapsed) · published_date→publishedAt ·`);
		rawLines.push(`   score / raw_content / id / images / request_id dropped · dedupe by url · cap maxResults.`);
		rawLines.push(src("packages/search-http/lib/adapters/tavily.js:90", "parseResponse(json, request, { maxResults })"));
		rawLines.push(src("packages/shared/src/text.js:91", "cleanSnippet()  ·  :71 dedupeBy()"));
		out.push(section(4, "Response — raw vendor body → adapter.parseResponse() → WebSearchResult", rawLines));
	}

	// ── 5 governor ─────────────────────────────────────────────────────────
	const g = r.governor;
	const govLines = [
		kv("caps", JSON.stringify(g.caps)),
		kv("from", `providerOverrides.${r.selection.selected ?? "?"} over base (snippetMaxChars ${g.config.snippetMaxChars} → ${g.caps.snippetMaxChars})`),
		kv("cache key", `normalizeQuery("${r.query}") = "${g.cacheKey}"`),
		kv("budget", `${g.config.budgetPerSession} searches / session`),
	];
	if (r.shaped) {
		govLines.push(``, `   shaped value  (${size(r.shaped.value, tok)})`);
		govLines.push(json(r.shaped.value, P));
		govLines.push(``, `   per-source snippet   raw → parsed → shaped`);
		const results = Array.isArray(w.response?.results) ? w.response.results : [];
		r.shaped.value.sources.forEach((sx, i) => {
			const raw = results[i]?.content?.length ?? "-";
			const parsed = r.result.sources[i]?.snippet?.length ?? 0;
			const sh = sx.snippet?.length ?? 0;
			govLines.push(`     #${i + 1} ${pad(raw)} → ${pad(parsed)} → ${pad(sh)}${String(sx.snippet ?? "").endsWith("…") ? "  (truncated)" : ""}  ${sx.title ?? sx.url}`);
		});
		const st = r.shaped.stats;
		govLines.push(``, `   context cost: raw ${w.response !== undefined ? size(w.response, tok) : "?"}  →  parsed ${st.charsBefore} chars ≈ ${st.tokensBefore} tok  →  shaped ${st.charsAfter} chars ≈ ${st.tokensAfter} tok`);
	}
	govLines.push(src("packages/search-governor/lib/index.js:301", "tools/post-execute arm ({ prepend: true }) → accept with replacement value"));
	govLines.push(src("packages/search-governor/lib/shape.js:67", "shapeSearchValue(): cleanUrl → dedupe → truncate snippets → cap answer → cap count"));
	govLines.push(src("packages/search-governor/lib/shape.js:36", "resolveCaps(base, overrides, providerId)"));
	out.push(section(5, "Governor shaping — what the model would actually see", govLines));

	// ── 6 cache / near-dup ─────────────────────────────────────────────────
	const sim = g.similarity;
	out.push(section(6, "Repeat protection — same session, no provider call", [
		`   Identical query → QueryCache hit (next() never invoked).`,
		`   Rephrased query → Jaccard on stemmed tokens ≥ ${sim.threshold} → "${g.config.nearDuplicateMode}" mode.`,
		kv("tokenize(q)", JSON.stringify(sim.a)),
		kv("tokenize(q')", `${JSON.stringify(sim.b)}   q' = "${sim.rephrased}"`),
		kv("jaccard", `${sim.score.toFixed(2)} → ${sim.score >= sim.threshold ? "flagged as near-duplicate" : "not flagged"}`),
		`   (known limitation: no CJK word segmentation — a Chinese query is one token)`,
		src("packages/search-governor/lib/index.js:228", "tools/execute arm: cache.get → findNearDuplicate → budget.consume → history.push"),
		src("packages/search-governor/lib/similarity.js:36", "tokenize()  ·  :53 jaccard()"),
		src("packages/search-governor/lib/cache.js", "QueryCache / normalizeQuery"),
	]));

	// ── 7 ledger ───────────────────────────────────────────────────────────
	out.push(section(7, "Accounting — governor ledger for this session (model-initiated searches only)", [
		...(g.ledger ? [json(g.ledger, P)] : [`   (empty — the governor only books web_search tool calls made by the model; this command bypasses the tool bus)`]),
		src("packages/search-governor/lib/ledger.js", "SessionLedger  ·  ledgerOf(sessionKey)"),
	]));

	// ── 8 errors table ─────────────────────────────────────────────────────
	out.push(section(8, "Failure vocabulary — vendor status → one WebError code", [
		`   401/403  → WEB_PROVIDER_ERROR              "rejected the API key; check the <ENV> credential"`,
		`   429      → WEB_PROVIDER_ERROR              rate limit`,
		`   432      → WEB_PROVIDER_ERROR              plan quota exhausted (Tavily)`,
		`   no key   → WEB_PROVIDER_CREDENTIAL_MISSING`,
		`   timeout  → WEB_PROVIDER_ERROR              "timed out after <timeoutMs> ms"`,
		`   abort    → WEB_ABORTED                     caller's AbortSignal`,
		`   seam     → WEB_PROVIDER_{AMBIGUOUS,UNAVAILABLE,CONFIGURED_MISSING,CONFIGURED_UNAVAILABLE}`,
		src("packages/search-http/lib/adapters/tavily.js:119", "describeError()"),
		src("packages/search-http/lib/index.js:169", "fetch error mapping"),
	]));

	out.push(``, rule("═"), ` Try next: send the same question to the model, then "/web-search-demo" again and compare`, ` STEP 3 (tool/call count) and STEP 7 (ledger) — those move only when the MODEL searches.`, rule("═"));
	return out.join("\n");
}
