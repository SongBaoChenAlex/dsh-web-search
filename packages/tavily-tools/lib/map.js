/**
 * The `web_map` tool: list the URLs under a site root via Tavily `/map`
 * without downloading page bodies. Cheap in tokens — a few dozen URLs — and
 * the natural precursor to `web_fetch` when the model already knows *which
 * site* holds the answer but not *which page*.
 *
 * `defineTool` comes from `@deepseek-ai/dsh-tools` and is resolved against the
 * DSH installation via `requireHost`; tests inject their own `defineTool`.
 *
 * @module @tobedone4byme/dsh-web-tavily-tools/map
 */
import { SessionBudget } from "./budget.js";
import { requireHost } from "@tobedone4byme/dsh-web-shared/host";

export const WEB_MAP_TOOL_NAME = "web_map";
export const WEB_MAP_SECTION_NAME = "tool:web_map";
/** Right after `tool:web_search` (110) / `tool:web_fetch` (111). */
export const WEB_MAP_SECTION_ORDER = 112;
export const WEB_MAP_GUIDANCE =
	"Use web_map to list the pages of a documentation or product site before fetching; it costs almost no context. "
	+ "Prefer web_map + web_fetch over repeated web_search when you already know the site.";

export const MAP_DEFAULTS = Object.freeze({
	budgetPerSession: 5,
	defaultLimit: 30,
	maxLimit: 100,
	maxDepth: 3,
	timeoutMs: 60_000,
});

export const DEFAULT_MAP_BUDGET_NOTICE =
	"web_map budget for this session is exhausted; this call was not performed. "
	+ "Use web_fetch on URLs you already know, or web_search.";

/** Session key for the budget bucket; `anonymous` for calls without an agent. */
export function sessionKeyOf(exec) {
	return exec?.agent?.session?.header?.id ?? "anonymous";
}

function clampInt(value, min, max, fallback) {
	const n = Math.trunc(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
}

/** Canonical key for dedupe: drop hash, trailing slash, lowercase host. */
function urlKey(u) {
	try {
		const p = new URL(u);
		p.hash = "";
		p.hostname = p.hostname.toLowerCase();
		return p.href.replace(/\/+$/u, "");
	} catch {
		return u.trim().replace(/\/+$/u, "");
	}
}

/**
 * Dedupe (by canonical key), sort, and cap.
 * @param {string[]} urls
 * @param {number} limit
 * @returns {{ urls: string[], truncated: boolean }}
 */
export function shapeUrls(urls, limit) {
	const seen = new Set();
	const unique = [];
	for (const raw of urls) {
		if (typeof raw !== "string") continue;
		const u = raw.trim();
		if (u.length === 0) continue;
		const key = urlKey(u);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(u);
	}
	unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const capped = unique.slice(0, Math.max(1, limit));
	return { urls: capped, truncated: unique.length > capped.length };
}

/**
 * Model-facing text for a `web_map` value.
 * @param {{ baseUrl: string, urls: string[], truncated: boolean, notice?: string }} value
 */
export function formatMapOutput(value) {
	if (typeof value.notice === "string" && value.notice.length > 0) return value.notice;
	const n = value.urls.length;
	const head = `Mapped ${value.baseUrl} (${n} URL${n === 1 ? "" : "s"}${value.truncated ? ", truncated" : ""}):`;
	const list = n > 0 ? value.urls.map((u) => `- ${u}`).join("\n") : "(no URLs found)";
	return `${head}\n${list}\nUse web_fetch on the relevant URL(s).`;
}

const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		baseUrl: { type: "string", required: true },
		urls: { type: "array", required: true, items: { type: "string" } },
		truncated: { type: "boolean", required: true },
		notice: { type: "string" },
	},
};

/**
 * Build the `defineTool` options object for `web_map` (pure; no registration).
 * @param {object} deps
 * @param {{ map: (url: string, opts: any, signal?: AbortSignal) => Promise<{ baseUrl: string, urls: string[] }> }} deps.client
 * @param {() => Partial<typeof MAP_DEFAULTS> & { budgetNotice?: string }} deps.config  thunk; re-read per call
 * @param {SessionBudget} deps.budget
 * @param {number} [deps.timeoutMs]  static tool timeout (defineTool requires a positive number)
 */
export function buildWebMapToolDefinition({ client, config, budget, timeoutMs }) {
	const cfg = () => ({ ...MAP_DEFAULTS, ...stripUndefined(config?.() ?? {}) });
	const toolTimeout = timeoutMs ?? cfg().timeoutMs ?? MAP_DEFAULTS.timeoutMs;
	return {
		name: WEB_MAP_TOOL_NAME,
		description: "Discover the URL structure of a website without downloading page content. Returns a list of URLs under the given root (optionally filtered by natural-language instructions). Cheap in tokens; use it before web_fetch to pick the right page instead of searching repeatedly.",
		parameters: {
			url: { type: "string", required: true, description: "Root URL to map, e.g. https://docs.example.com" },
			instructions: { type: "string", description: "Optional natural-language filter, e.g. \"only API reference pages\"" },
			limit: { type: "number", description: "Max URLs to return (default 30, max 100)" },
			maxDepth: { type: "number", description: "Crawl depth 1-3 (default 1)" },
		},
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: "text", text: formatMapOutput(value) }],
			presentationMeta: (_args, value) => ({
				baseUrl: value.baseUrl,
				count: value.urls.length,
				truncated: value.truncated,
				...(value.notice !== undefined ? { budgetExhausted: true } : {}),
			}),
		},
		timeoutMs: toolTimeout,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const c = cfg();
			const url = String(args?.url ?? "").trim();
			if (url.length === 0) throw new Error("url must be a non-empty string");
			let parsed;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error(`url must be an absolute http(s) URL (got ${JSON.stringify(url)})`);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error(`url scheme "${parsed.protocol.replace(/:$/u, "")}" is not supported; only http and https are`);
			}

			const { allowed, used, limit } = budget.consume(sessionKeyOf(exec));
			if (!allowed) {
				const notice = typeof c.budgetNotice === "string" && c.budgetNotice.length > 0 ? c.budgetNotice : DEFAULT_MAP_BUDGET_NOTICE;
				return { baseUrl: url, urls: [], truncated: false, notice: `${notice} (${used}/${limit} used)` };
			}

			const maxLimit = clampInt(c.maxLimit, 1, 1000, MAP_DEFAULTS.maxLimit);
			const wanted = clampInt(args?.limit, 1, maxLimit, clampInt(c.defaultLimit, 1, maxLimit, MAP_DEFAULTS.defaultLimit));
			const maxDepth = clampInt(args?.maxDepth, 1, clampInt(c.maxDepth, 1, 5, MAP_DEFAULTS.maxDepth), 1);
			const instructions = typeof args?.instructions === "string" && args.instructions.trim().length > 0 ? args.instructions.trim() : undefined;

			const result = await client.map(url, { maxDepth, limit: wanted, ...(instructions ? { instructions } : {}) }, exec?.signal);
			const shaped = shapeUrls(result.urls, wanted);
			return { baseUrl: result.baseUrl || url, urls: shaped.urls, truncated: shaped.truncated };
		},
	};
}

function stripUndefined(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v;
	return out;
}

/**
 * `defineTool` from the host, resolved against the DSH installation (a bare
 * `import("@deepseek-ai/dsh-tools")` from a plugin directory does NOT resolve).
 * Throws when unavailable: registering the raw DSL would be rejected by
 * `ctx.tools.register` anyway, so there is no meaningful fallback.
 */
async function loadDefineTool(ctx) {
	const mod = await requireHost(ctx, "@deepseek-ai/dsh-tools");
	if (typeof mod.defineTool !== "function") throw new Error("@deepseek-ai/dsh-tools does not export defineTool");
	return mod.defineTool;
}
/**
 * Register `web_map` and its system-prompt section.
 * @param {any} ctx  needs `tools.register` and (optionally) `systemPrompt.section`
 * @param {object} deps
 * @param {any} deps.client
 * @param {() => any} deps.config    thunk returning the live `map` config section
 * @param {SessionBudget} [deps.budget]
 * @param {(definition: any) => any} [deps.defineTool]  override for tests
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{ budget: SessionBudget, definition: any, tool: any }>}
 */
export async function applyWebMapTool(ctx, { client, config, budget, defineTool, timeoutMs }) {
	const cfg = typeof config === "function" ? config : () => config ?? {};
	const sessionBudget = budget ?? new SessionBudget(() => cfg().budgetPerSession ?? MAP_DEFAULTS.budgetPerSession);
	const definition = buildWebMapToolDefinition({ client, config: cfg, budget: sessionBudget, timeoutMs });

	try {
		if (ctx?.systemPrompt && typeof ctx.systemPrompt.section === "function") {
			ctx.systemPrompt.section({ name: WEB_MAP_SECTION_NAME, order: WEB_MAP_SECTION_ORDER, text: WEB_MAP_GUIDANCE });
		}
	} catch (error) {
		ctx?.logger?.warn?.(`web-tavily-tools: could not register the web_map prompt section (${String(error)})`);
	}

	const define = defineTool ?? await loadDefineTool(ctx);
	const tool = define(definition);
	ctx.tools.register(tool);
	return { budget: sessionBudget, definition, tool };
}

export { SessionBudget };
