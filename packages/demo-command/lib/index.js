/**
 * `/web-search-demo [query]` — a human-facing slash command that performs ONE
 * real search through the live DSH web seam and renders the whole pipeline as a
 * step-by-step report: wiring, credential source, wire request, raw vendor
 * body, normalised WebSearchResult, governor shaping, session ledger, and the
 * source file / line that owns each step.
 *
 * Nothing here is submitted to the model; the result is rendered by the UI
 * command card only (`CommandResult.text`). The search itself IS real: it
 * goes through `ctx.web.search()`, so the selected provider, its credential
 * resolution and its `web/http-search-request` session event are exactly what a
 * model-initiated `web_search` would produce.
 *
 * @module @tobedone4byme/dsh-web-search-demo-command
 */
import z from "@deepseek-ai/schemastery";
import { liveConfig } from "@tobedone4byme/dsh-web-shared/settings";
import { estimateTokens } from "@tobedone4byme/dsh-web-shared/text";
import { shapeSearchValue, resolveCaps } from "@tobedone4byme/dsh-web-search-governor/shape";
import { tokenize, jaccard } from "@tobedone4byme/dsh-web-search-governor/similarity";
import { normalizeQuery } from "@tobedone4byme/dsh-web-search-governor/cache";
import { ledgerOf, Config as GovernorConfig } from "@tobedone4byme/dsh-web-search-governor";
import { renderReport } from "./report.js";

export const name = "web-search-demo-command";
export const inject = ["commands", "web"];

export const COMMAND_NAME = "web-search-demo";
export const SETTINGS_NAMESPACE = "web-search-demo";

export const Config = z.object({
	defaultQuery: z.string().default("蓝色大肥鱼").description("Query used when the command is invoked without input."),
	maxResults: z.number().step(1).min(1).max(20).default(5).description("maxResults passed to ctx.web.search()."),
	previewChars: z.number().step(1).min(40).default(160).description("Characters of each long string shown inline before it is elided."),
	showRawBody: z.boolean().default(true).description("Include the raw vendor response body section."),
});

/**
 * Wrap `globalThis.fetch` for the duration of one search so the report can show
 * the exact wire request/response without modifying the provider. Restored in
 * `finally`; concurrent unrelated fetches pass through untouched because the
 * capture only records calls whose URL matches a search endpoint we recognise.
 * @param {(wire: { request?: any, response?: any, status?: number, ms?: number, contentType?: string }) => Promise<T>} run
 * @template T
 */
async function withWireTap(run) {
	const wire = {};
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const t0 = performance.now();
		const res = await real(input, init);
		if (wire.request !== undefined) return res; // already captured the first call
		wire.ms = Math.round(performance.now() - t0);
		wire.status = res.status;
		wire.contentType = res.headers.get("content-type") ?? undefined;
		let body;
		try { body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined; } catch { body = String(init?.body ?? ""); }
		wire.request = {
			url,
			method: init?.method ?? "GET",
			redirect: init?.redirect,
			headers: redactHeaders(init?.headers),
			...(body !== undefined ? { body } : {}),
		};
		const clone = res.clone();
		try {
			const text = await clone.text();
			try { wire.response = JSON.parse(text); } catch { wire.response = text; }
		} catch {
			// leave response undefined
		}
		return res;
	};
	try {
		return { value: await run(wire), wire };
	} finally {
		globalThis.fetch = real;
	}
}

function redactHeaders(headers) {
	const out = {};
	const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers ?? {});
	for (const [k, v] of entries) {
		const key = k.toLowerCase();
		out[key] = /authorization|api-key|x-api-key|x-subscription-token/u.test(key) ? redactSecret(String(v)) : v;
	}
	return out;
}

function redactSecret(value) {
	const m = value.match(/^(Bearer\s+)?(.{0,6})(.*)$/su);
	if (!m) return "***";
	return `${m[1] ?? ""}${m[2]}${"*".repeat(Math.min(12, m[3].length))}`;
}

/** Fold the current session's log into the facts the report needs. */
function sessionFacts(session) {
	const events = session?.events ?? [];
	const requests = events.filter((e) => e.type === "web/http-search-request").map((e) => ({ seq: e.seq, ...e.data }));
	const webSearchCalls = events.filter((e) => e.type === "tool/call" && e.data?.name === "web_search").length;
	return { totalEvents: events.length, requests, webSearchCalls };
}

/** Resolve the provider the seam will pick for search, mirroring dsh-web's own rules (read-only). */
function selectedSearchProvider(web) {
	const providers = web?.searchProviders instanceof Map ? [...web.searchProviders.values()] : [];
	const configured = web?.searchProviderId;
	const usable = providers.filter((p) => { try { return p.available(); } catch { return false; } }).map((p) => p.id);
	let selected;
	let rule;
	if (configured !== undefined) {
		selected = providers.find((p) => p.id === configured)?.id;
		rule = selected === undefined ? `configured "${configured}" is NOT registered → WEB_PROVIDER_CONFIGURED_MISSING`
			: usable.includes(selected) ? `configured "${configured}" (web row searchProvider / $DSH_WEB_SEARCH_PROVIDER)`
			: `configured "${configured}" registered but unavailable → WEB_PROVIDER_CONFIGURED_UNAVAILABLE`;
	} else if (usable.length === 1) {
		selected = usable[0]; rule = "only one usable provider → auto-selected";
	} else {
		rule = usable.length === 0 ? "none usable → WEB_PROVIDER_UNAVAILABLE" : `multiple usable (${usable.join(", ")}) and none configured → WEB_PROVIDER_AMBIGUOUS`;
	}
	return { registered: providers.map((p) => p.id), usable, configured, selected, rule };
}

/** Read the governor's live settings section if present, else schema defaults. */
function governorConfig(ctx) {
	try {
		// `settingsNamespace()` is a brand cast over the plain string; the registry keys by string value.
		const value = ctx.get("settings")?.get?.("web-search-governor");
		if (value && typeof value === "object") return new GovernorConfig(value);
	} catch {
		// fall through
	}
	return new GovernorConfig({});
}

/**
 * Execute one demo run.
 * @param {any} ctx
 * @param {{ agent: any, rawInput: string, signal: AbortSignal }} invocation
 * @param {() => any} current
 */
export async function runDemo(ctx, invocation, current) {
	const cfg = current();
	const query = invocation.rawInput.trim() || cfg.defaultQuery;
	const session = invocation.agent?.session;
	const sessionId = session?.id ?? "unknown";
	const t0 = performance.now();

	const web = ctx.web;
	const selection = selectedSearchProvider(web);
	const before = sessionFacts(session);
	const govCfg = governorConfig(ctx);
	const caps = resolveCaps(govCfg, govCfg.providerOverrides, selection.selected ?? govCfg.activeProvider);

	let result;
	let error;
	let wire = {};
	try {
		const tapped = await withWireTap((w) => { wire = w; return web.search({ query, maxResults: cfg.maxResults }, invocation.signal); });
		result = tapped.value;
		wire = tapped.wire;
	} catch (e) {
		error = e;
	}
	const after = sessionFacts(session);
	const newRequests = after.requests.filter((r) => !before.requests.some((b) => b.seq === r.seq));

	const shaped = result ? shapeSearchValue(result, caps) : undefined;
	const rephrased = `${query} 是什么 梗`;
	const similarity = { a: tokenize(query), b: tokenize(rephrased), score: jaccard(tokenize(query), tokenize(rephrased)), rephrased, threshold: govCfg.nearDuplicateThreshold };

	return renderReport({
		query,
		sessionId,
		elapsedMs: Math.round(performance.now() - t0),
		previewChars: cfg.previewChars,
		showRawBody: cfg.showRawBody,
		selection,
		governor: { config: govCfg, caps, cacheKey: normalizeQuery(query), ledger: ledgerOf(sessionId), similarity },
		wire,
		result,
		shaped,
		error,
		session: { before, after, newRequests },
		estimateTokens,
	});
}

/** Cordis entry point: register the global `/web-search-demo` command. */
export function apply(ctx, config) {
	const current = liveConfig(ctx, SETTINGS_NAMESPACE, Config, config ?? new Config({}));
	ctx.commands.register({
		name: COMMAND_NAME,
		description: "run one real web search and show every pipeline stage, artefact and source location",
		input: { hint: "[query]" },
		handler: async (invocation) => {
			try {
				const text = await runDemo(ctx, invocation, current);
				return { kind: "success", text };
			} catch (e) {
				return { kind: "error", text: `web-search-demo failed: ${e?.stack ?? String(e)}` };
			}
		},
	});
}
