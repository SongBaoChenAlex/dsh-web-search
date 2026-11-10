/**
 * `@baoson/dsh-web-search-governor` — a DeepSeek Harness plugin that keeps
 * `web_search` from eating the context window:
 *
 * 1. **Cache** (`tools/execute`): an identical (normalized) query in the same
 *    session returns the earlier result without touching the provider.
 * 2. **Near-duplicate detection** (`tools/execute` + `tools/post-execute`): a
 *    rephrased repeat of an earlier query (Jaccard on stemmed tokens ≥
 *    `nearDuplicateThreshold`) either gets a one-line note prepended to the
 *    results (`notice`) or is answered from the cache / a notice (`block`).
 * 3. **Budget** (`tools/execute`): after `budgetPerSession` searches the tool
 *    returns a notice instead of results — `next()` is never called, so no
 *    provider / inner-model cost is incurred.
 * 4. **Shaping** (`tools/post-execute`): dedupe by cleaned URL, strip tracking
 *    params, cap snippet / answer length and source count. Returned as an
 *    `accept` with a replacement `value`, so the official tool re-renders the
 *    text and the UI card from the smaller value.
 * 5. **Accounting** (`tools/post-execute`): per-session ledger of raw vs shaped
 *    tokens (`ledgerOf(sessionKey)`, `applyWith(...).ledger`) and one
 *    `ctx.logger.info` line per governed search.
 * 6. **Guidance**: a system-prompt section right after the official
 *    `tool:web_search` section (`guidance: false` disables it).
 *
 * The plugin never calls the network or a model. Every arm is wrapped so a
 * governor bug falls through to stock behaviour instead of breaking the tool.
 *
 * ## Settings seam
 * Live overrides come from the `web-search-governor` section of
 * `~/.dsh/settings.yaml` via `@deepseek-ai/dsh-settings`. That package is
 * loaded with a dynamic `import()` inside `apply` (hooks are registered
 * synchronously first and read `current()` at call time), so unit tests can
 * run `apply` against a fake `ctx` without the DSH host installed, and a
 * missing/failed settings package degrades to the static mount config.
 * `applyWith(ctx, config, { installSettings })` exposes the seam explicitly.
 *
 * @module @baoson/dsh-web-search-governor
 */
import z from "@deepseek-ai/schemastery";
import { shapeSearchValue, resolveCaps } from "./shape.js";
import { SessionBudget } from "./budget.js";
import { QueryCache, normalizeQuery } from "./cache.js";
import { QueryHistory, findNearDuplicate } from "./similarity.js";
import { SessionLedger } from "./ledger.js";
import { estimateTokens } from "@baoson/dsh-web-shared/text";
import { plainConfig } from "@baoson/dsh-web-shared/volatile";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-governor";
/** `tools` for the execute / post-execute waterfalls; `systemPrompt` for the guidance section. */
export const inject = ["tools", "systemPrompt"];

export const SETTINGS_NAMESPACE = "web-search-governor";
export const TOOL_NAME = "web_search";
export const GUIDANCE_SECTION_NAME = "tool:web_search:governor";
/** Just after the official `tool:web_search` section (110). Ties are stable-sorted, so sharing 111 with `tool:web_fetch` is harmless. */
export const GUIDANCE_SECTION_ORDER = 111;

export const DEFAULT_BUDGET_NOTICE =
	"Web search budget for this session is exhausted; this search was not performed. " +
	"Proceed with the search results and fetched pages already in this conversation, or use web_fetch on URLs you already know. " +
	"In your answer, state clearly which claims could not be verified because no further searches were available.";

export const GUIDANCE_TEXT =
	"**Using web search responsibly.** Before searching, check whether an earlier search result or fetched page in this conversation already answers the question. " +
	"Do not repeat a search with rephrased or synonymous wording. When a result looks relevant but the snippet is insufficient, use `web_fetch` on that URL instead of searching again. " +
	"Prefer one well-formed query over several narrow ones. Searches in this session are limited to a fixed budget; when it is exhausted the tool returns a notice and you must proceed with what you already have, stating clearly what could not be verified. " +
	"Rephrased repeats of an earlier search are detected and flagged; when flagged, change the angle of your query or answer from what you already have instead of searching again.";

/**
 * Notice returned in `nearDuplicateMode: "block"` when the earlier result is no longer cached.
 * @param {string} earlier
 * @param {number} score
 */
export function nearDuplicateNotice(earlier, score) {
	return `This query is a near-duplicate (similarity ${score.toFixed(2)}) of "${earlier}", which was already searched this session; this search was not performed. ` +
		"Reuse those earlier results or change the angle of the query.";
}

/**
 * One-line note prepended to the content in `nearDuplicateMode: "notice"`.
 * @param {string} earlier
 * @param {number} score
 */
export function nearDuplicateNoteLine(earlier, score) {
	return `Note: this query closely matches an earlier search ("${earlier}", similarity ${score.toFixed(1)}); if the results overlap, stop searching and answer.`;
}

const CapOverride = z.object({
	maxSources: z.number().step(1).min(0),
	snippetMaxChars: z.number().step(1).min(0),
	contentMaxChars: z.number().step(1).min(0),
	stripTrackingParams: z.boolean(),
});

/**
 * Every field is `.volatile()`: on dsh >= 0.2 that is what makes it editable
 * from the settings UI, and edits land in the running plugin through the
 * reference (`field.get()`) without a re-apply. Reads go through
 * `plainConfig()` so plain objects (tests, older hosts) work the same.
 */
export const Config = z.object({
	maxSources: z.number().step(1).min(0).default(5).description("Sources kept after dedupe (0 = unlimited).").volatile(),
	snippetMaxChars: z.number().step(1).min(0).default(300).description("Per-source snippet cap in characters (0 = unlimited).").volatile(),
	contentMaxChars: z.number().step(1).min(0).default(1500).description("Cap for the provider's synthesized answer (0 = unlimited).").volatile(),
	budgetPerSession: z.number().step(1).min(0).default(10).description("web_search calls allowed per session (0 = unlimited).").volatile(),
	budgetNotice: z.string().default(DEFAULT_BUDGET_NOTICE).description("Text returned instead of results once the budget is exhausted.").volatile(),
	stripTrackingParams: z.boolean().default(true).description("Remove utm_*, fbclid, gclid, … from source URLs.").volatile(),
	guidance: z.boolean().default(true).description("Register the responsible-search system-prompt section (takes effect on restart).").volatile(),
	cache: z.boolean().default(true).description("Return the earlier result for a repeated identical query in the same session.").volatile(),
	cacheTtlMs: z.number().step(1).min(0).default(30 * 60 * 1000).description("Cache entry lifetime in milliseconds.").volatile(),
	nearDuplicate: z.boolean().default(true).description("Detect rephrased repeats of an earlier query in the same session.").volatile(),
	nearDuplicateThreshold: z.number().min(0).max(1).default(0.5).description("Jaccard similarity (on stemmed tokens) at or above which a query counts as a near-duplicate.").volatile(),
	nearDuplicateMode: z.union(["notice", "block"]).default("notice").description("`notice` prepends a one-line note to the results; `block` skips the provider and returns the earlier result or a notice.").volatile(),
	logAccounting: z.boolean().default(true).description("Emit one `ctx.logger.info` line per governed search with raw → shaped token counts.").volatile(),
	providerOverrides: z.dict(CapOverride).default({ tavily: { snippetMaxChars: 800 } }).description("Per-provider-id overrides of the caps above.").volatile(),
	activeProvider: z.string().description("Provider id whose override applies (e.g. the `web` row's searchProvider).").volatile(),
});

/** Session key for budget / cache buckets; `anonymous` for calls without an agent. */
function sessionKeyOf(exec) {
	return exec?.agent?.session?.header?.id ?? "anonymous";
}

/** Plain-object check for safe meta spreading. */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Logger that never throws when `ctx.logger` is absent (direct/test contexts). */
function loggerOf(ctx) {
	const l = ctx?.logger;
	return {
		debug: (...a) => { try { l?.debug?.(...a); } catch { /* ignore */ } },
		info: (...a) => { try { l?.info?.(...a); } catch { /* ignore */ } },
		warn: (...a) => { try { l?.warn?.(...a); } catch { /* ignore */ } },
		has: l !== undefined && l !== null,
	};
}

/** Safe `JSON.stringify` → token estimate for accounting; `0` on failure. */
function tokensOf(value) {
	try {
		return estimateTokens(typeof value === "string" ? value : JSON.stringify(value ?? ""));
	} catch {
		return 0;
	}
}

/** Key for the execute → post-execute hand-over of near-duplicate markers. */
function noteKey(sessionKey, query) {
	return `${sessionKey}\u0000${normalizeQuery(query)}`;
}
const PENDING_NOTES_MAX = 1000;

/** Ledger of the most recent `applyWith` mount, so `ledgerOf()` works without a handle. */
let activeLedger = new SessionLedger({ maxSessions: 500 });

/**
 * Read the accounting ledger of a session from the active mount (undefined when nothing was recorded yet).
 * @param {string} sessionKey
 * @returns {import("./ledger.js").LedgerEntry | undefined}
 */
export function ledgerOf(sessionKey) {
	return activeLedger.peek(sessionKey);
}

/**
 * Default settings installer: dynamic import so tests and hosts without
 * `@deepseek-ai/dsh-settings` still work.
 * @returns {Promise<void>}
 */
async function defaultInstallSettings(ctx, Schema, config, setSource, log) {
	let mod;
	try {
		mod = await import("@baoson/dsh-web-shared/settings");
	} catch (error) {
		log.debug(`web-search-governor: settings integration unavailable (${String(error)}); using static config`);
		return;
	}
	try {
		const current = mod.liveConfig(ctx, SETTINGS_NAMESPACE, Schema, config);
		setSource(current);
	} catch (error) {
		log.warn(`web-search-governor: installSettingsSection failed (${String(error)}); using static config`);
	}
}

/**
 * Register the governor against `ctx`.
 * @param {any} ctx
 * @param {any} config  validated plugin config
 * @param {{ installSettings?: (ctx: any, Schema: any, config: any, setSource: (src: () => any) => void, log: any) => void | Promise<void>, now?: () => number }} [deps]
 * @returns {{ budget: SessionBudget, cache: QueryCache, history: QueryHistory, ledger: SessionLedger, current: () => any }}
 */
export function applyWith(ctx, config, deps = {}) {
	const log = loggerOf(ctx);
	let current = () => config ?? {};
	const cfg = () => {
		try {
			return plainConfig(current() ?? config ?? {});
		} catch {
			return plainConfig(config ?? {});
		}
	};

	// dsh >= 0.2 auto-generates a settings page from `Config`; this plugin ships
	// its own "Web search governor" section, so opt out of the generated one.
	if (typeof ctx.inject === "function") {
		try {
			ctx.inject(["settings"], (child) => {
				if (typeof child.settings?.configure !== "function") return;
				child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), "web-search-governor: settings presentation");
			});
		} catch (error) {
			log.debug(`web-search-governor: settings presentation not configured (${String(error)})`);
		}
	}

	const budget = new SessionBudget(() => cfg().budgetPerSession ?? 10, { maxSessions: 500 });
	const cache = new QueryCache({ ttlMs: () => cfg().cacheTtlMs ?? 30 * 60 * 1000, maxPerSession: 50, maxSessions: 500, ...(deps.now ? { now: deps.now } : {}) });
	const history = new QueryHistory({ maxPerSession: 50, maxSessions: 500 });
	const ledger = new SessionLedger({ maxSessions: 500 });
	activeLedger = ledger;
	/** @type {Map<string, { earlier: string, score: number }>} near-duplicate markers handed from execute → post-execute */
	const pendingNotes = new Map();
	const putNote = (key, note) => {
		pendingNotes.delete(key);
		pendingNotes.set(key, note);
		while (pendingNotes.size > PENDING_NOTES_MAX) {
			const oldest = pendingNotes.keys().next().value;
			if (oldest === undefined) break;
			pendingNotes.delete(oldest);
		}
	};
	const takeNote = (key) => {
		const note = pendingNotes.get(key);
		if (note !== undefined) pendingNotes.delete(key);
		return note;
	};

	// TODO(token-meter): `ctx.get("tokenMeter")` was probed as a possible host-side
	// token accounting service; the fake test ctx returns `undefined` and no API was
	// verified against the DSH host, so nothing is integrated here. When such a
	// service is confirmed, forward `{ rawTokens, shapedTokens }` from the
	// post-execute arm instead of (or in addition to) the log line below.

	// --- execute arm: cache + near-duplicate + budget ------------------------------------
	ctx.on("tools/execute", async (exec, next) => {
		let sessionKey;
		let query;
		let c;
		try {
			if (exec?.name !== TOOL_NAME || exec?.parent !== undefined) return next();
			c = cfg();
			sessionKey = sessionKeyOf(exec);
			query = exec?.arguments?.query;

			if (c.cache !== false) {
				const hit = cache.get(sessionKey, query);
				if (hit !== undefined) {
					log.debug(`web-search-governor: cache hit for session ${sessionKey}`);
					ledger.add(sessionKey, { cacheHits: 1 });
					const meta = isPlainObject(hit.meta) ? { ...hit.meta, governor: { ...(isPlainObject(hit.meta.governor) ? hit.meta.governor : {}), cached: true } } : hit.meta;
					return { ...hit, ...(meta !== undefined ? { meta } : {}) };
				}
			}

			if (c.nearDuplicate !== false) {
				const dup = findNearDuplicate(query, history.list(sessionKey), c.nearDuplicateThreshold ?? 0.5);
				if (dup !== undefined) {
					ledger.add(sessionKey, { nearDuplicates: 1 });
					log.debug(`web-search-governor: near-duplicate query in session ${sessionKey} (score ${dup.score.toFixed(2)} vs "${dup.query}")`);
					if (c.nearDuplicateMode === "block") {
						const governor = { nearDuplicate: { of: dup.query, score: dup.score } };
						const earlier = c.cache !== false ? cache.get(sessionKey, dup.query) : undefined;
						if (earlier !== undefined) {
							const meta = isPlainObject(earlier.meta) ? { ...earlier.meta, governor: { ...(isPlainObject(earlier.meta.governor) ? earlier.meta.governor : {}), cached: true, ...governor } } : earlier.meta;
							return { ...earlier, ...(meta !== undefined ? { meta } : {}) };
						}
						const notice = nearDuplicateNotice(dup.query, dup.score);
						return {
							isError: false,
							value: { content: notice, sources: [], truncated: false },
							content: [{ type: "text", text: notice }],
							meta: { sources: [], truncated: false, answer: notice, governor },
						};
					}
					putNote(noteKey(sessionKey, query), { earlier: dup.query, score: dup.score });
				}
			}

			const { allowed, used, limit } = budget.consume(sessionKey);
			if (!allowed) {
				log.debug(`web-search-governor: budget exhausted for session ${sessionKey} (${used}/${limit})`);
				ledger.add(sessionKey, { budgetBlocks: 1 });
				pendingNotes.delete(noteKey(sessionKey, query));
				const notice = typeof c.budgetNotice === "string" && c.budgetNotice.length > 0 ? c.budgetNotice : DEFAULT_BUDGET_NOTICE;
				return {
					isError: false,
					value: { content: notice, sources: [], truncated: false },
					content: [{ type: "text", text: notice }],
					meta: { sources: [], truncated: false, answer: notice, governor: { budgetExhausted: true, used, limit } },
				};
			}
			history.push(sessionKey, query);
		} catch (error) {
			log.warn(`web-search-governor: execute arm failed (${String(error)}); falling through`);
			return next();
		}

		const result = await next();
		try {
			if (c.cache !== false && result && result.isError === false) cache.set(sessionKey, query, result);
		} catch (error) {
			log.warn(`web-search-governor: cache store failed (${String(error)})`);
		}
		return result;
	});

	// --- post-execute arm: shaping + near-duplicate note + accounting ---------------------
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const decision = await next();
		try {
			if (exec?.name !== TOOL_NAME || exec?.parent !== undefined) return decision;
			if (!decision || decision.kind !== "accept" || Object.hasOwn(decision, "content")) return decision;
			if (!result || result.isError !== false) return decision;
			const input = Object.hasOwn(decision, "value") ? decision.value : result.value;
			if (!isPlainObject(input) || !Array.isArray(input.sources)) return decision;

			const c = cfg();
			const sessionKey = sessionKeyOf(exec);
			const query = exec?.arguments?.query;
			const note = takeNote(noteKey(sessionKey, query));
			const cached = isPlainObject(result.meta) && isPlainObject(result.meta.governor) && result.meta.governor.cached === true;

			const rawTokens = tokensOf(result.value);
			const caps = resolveCaps(c, c.providerOverrides, c.activeProvider);
			const { value, stats } = shapeSearchValue(input, caps);
			if (note !== undefined) {
				const line = nearDuplicateNoteLine(note.earlier, note.score);
				value.content = typeof value.content === "string" && value.content.length > 0 ? `${line}\n${value.content}` : line;
			}
			const shapedTokens = tokensOf(value);
			log.debug(`web-search-governor: shaped web_search result: ${stats.charsBefore} → ${stats.charsAfter} chars (~${stats.tokensBefore} → ~${stats.tokensAfter} tokens), sources ${stats.sourcesBefore} → ${stats.sourcesAfter}`);

			if (!cached) ledger.add(sessionKey, { searches: 1, rawTokens, shapedTokens });
			if (c.logAccounting !== false && log.has) {
				const { used, limit } = budget.peek(sessionKey);
				const pct = rawTokens > 0 ? Math.round((1 - shapedTokens / rawTokens) * 100) : 0;
				const sign = pct > 0 ? "−" : pct < 0 ? "+" : "";
				const state = cached ? "cache hit" : note !== undefined ? "near-duplicate" : "cache miss";
				log.info(`web_search governed: raw≈${rawTokens} tok → ${shapedTokens} tok (${sign}${Math.abs(pct)}%), session ${used}/${limit === 0 ? "∞" : limit}, ${state}`);
			}
			return {
				kind: "accept",
				value,
				...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
			};
		} catch (error) {
			log.warn(`web-search-governor: post-execute arm failed (${String(error)}); keeping original decision`);
			return decision;
		}
	}, { prepend: true });

	// --- guidance ---------------------------------------------------------------------
	try {
		if ((cfg().guidance ?? true) !== false && ctx.systemPrompt && typeof ctx.systemPrompt.section === "function") {
			ctx.systemPrompt.section({ name: GUIDANCE_SECTION_NAME, order: GUIDANCE_SECTION_ORDER, text: GUIDANCE_TEXT });
		}
	} catch (error) {
		log.warn(`web-search-governor: could not register the guidance section (${String(error)})`);
	}

	// --- live settings (async, best-effort) ---------------------------------------------
	const install = deps.installSettings ?? defaultInstallSettings;
	try {
		Promise.resolve(install(ctx, Config, config, (source) => { current = source; }, log)).catch((error) => {
			log.warn(`web-search-governor: settings integration failed (${String(error)})`);
		});
	} catch (error) {
		log.warn(`web-search-governor: settings integration failed (${String(error)})`);
	}

	return { budget, cache, history, ledger, current: cfg };
}

/** Cordis entry point. */
export function apply(ctx, config) {
	applyWith(ctx, config);
}

export { shapeSearchValue, resolveCaps, SessionBudget, QueryCache, QueryHistory, SessionLedger, findNearDuplicate };
