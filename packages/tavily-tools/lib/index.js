/**
 * `@baoson/dsh-web-tavily-tools` — Tavily Extract + Map + Research for the DeepSeek Harness.
 *
 * One plugin, three registrations sharing one API key and one HTTP client:
 * - `extract.enabled`  → a `web_fetch` provider with id `tavily-extract`
 *   (registered, not selected: the `web` row's `fetchProvider` decides).
 * - `map.enabled`      → the `web_map` tool + its system-prompt section.
 * - `research.enabled` → the `web_research` tool + its system-prompt section.
 *
 * Live overrides come from the `web-tavily-tools:` section of
 * `~/.dsh/settings.yaml` via `@baoson/dsh-web-shared/settings`.
 *
 * @module @baoson/dsh-web-tavily-tools
 */
import z from "@deepseek-ai/schemastery";
import { liveConfig } from "@baoson/dsh-web-shared/settings";
import { apiKeyResolver } from "@baoson/dsh-web-shared/credentials";
import { bindHost } from "@baoson/dsh-web-shared/http";
import { createTavilyClient, TAVILY_DEFAULT_API_KEY_ENV, TAVILY_DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from "./tavily-client.js";
import { TavilyExtractFetchProvider, TAVILY_EXTRACT_PROVIDER_ID, EXTRACT_DEFAULTS } from "./extract.js";
import { applyWebMapTool, MAP_DEFAULTS, DEFAULT_MAP_BUDGET_NOTICE, SessionBudget, WEB_MAP_TOOL_NAME, WEB_MAP_SECTION_NAME } from "./map.js";
import { applyWebResearchTool, RESEARCH_DEFAULTS, DEFAULT_RESEARCH_BUDGET_NOTICE } from "./research.js";

export { TAVILY_EXTRACT_PROVIDER_ID, TavilyExtractFetchProvider, EXTRACT_DEFAULTS } from "./extract.js";
export { applyWebMapTool, buildWebMapToolDefinition, formatMapOutput, shapeUrls, MAP_DEFAULTS, WEB_MAP_TOOL_NAME, WEB_MAP_SECTION_NAME, WEB_MAP_SECTION_ORDER, WEB_MAP_GUIDANCE, SessionBudget } from "./map.js";
export { applyWebResearchTool, buildWebResearchToolDefinition, formatResearchOutput, shapeSources, capAnswer, researchGuidance, RESEARCH_DEFAULTS, DEFAULT_RESEARCH_BUDGET_NOTICE, WEB_RESEARCH_TOOL_NAME, WEB_RESEARCH_SECTION_NAME, WEB_RESEARCH_SECTION_ORDER, WEB_RESEARCH_GUIDANCE, WEB_RESEARCH_DESCRIPTION } from "./research.js";
export { createTavilyClient, describeTavilyError } from "./tavily-client.js";
export { TAVILY_ENDPOINTS } from "./client-api.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-tavily-tools";
/** `web` for the fetch provider, `tools` + `systemPrompt` for `web_map`. */
export const inject = ["web", "tools", "systemPrompt"];

export const SETTINGS_NAMESPACE = "web-tavily-tools";

export const Config = z.object({
	apiKey: z.string().role("secret").description("Literal Tavily API key. Prefer `apiKeyEnv`."),
	apiKeyEnv: z.string().role("credential-ref").default(TAVILY_DEFAULT_API_KEY_ENV).description("Credential / environment variable name holding the key."),
	baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL).description("Tavily API base URL."),
	timeoutMs: z.number().step(1).min(0).default(DEFAULT_TIMEOUT_MS).description("Per-request HTTP timeout in ms; 0 disables."),
	extract: z.object({
		enabled: z.boolean().default(true).description("Register the `tavily-extract` web_fetch provider."),
		depth: z.union(["basic", "advanced"]).default(EXTRACT_DEFAULTS.depth).description("`advanced` costs 2× credits and handles complex layouts / tables better."),
		maxOutputChars: z.number().step(1).min(1000).default(EXTRACT_DEFAULTS.maxOutputChars).description("Cap on the returned body; a visible [truncated] trailer is appended."),
	}).default({ enabled: true, depth: EXTRACT_DEFAULTS.depth, maxOutputChars: EXTRACT_DEFAULTS.maxOutputChars }),
	map: z.object({
		enabled: z.boolean().default(true).description("Register the `web_map` tool."),
		budgetPerSession: z.number().step(1).min(0).default(MAP_DEFAULTS.budgetPerSession).description("web_map calls allowed per session (0 = unlimited)."),
		defaultLimit: z.number().step(1).min(1).default(MAP_DEFAULTS.defaultLimit).description("URLs returned when the model gives no `limit`."),
		maxLimit: z.number().step(1).min(1).default(MAP_DEFAULTS.maxLimit).description("Hard ceiling on `limit`."),
		maxDepth: z.number().step(1).min(1).max(5).default(MAP_DEFAULTS.maxDepth).description("Hard ceiling on `maxDepth`."),
		timeoutMs: z.number().step(1).min(1000).default(MAP_DEFAULTS.timeoutMs).description("Cooperative tool-call timeout attached to web_map."),
		budgetNotice: z.string().default(DEFAULT_MAP_BUDGET_NOTICE),
	}).default({ enabled: true, budgetPerSession: MAP_DEFAULTS.budgetPerSession, defaultLimit: MAP_DEFAULTS.defaultLimit, maxLimit: MAP_DEFAULTS.maxLimit, maxDepth: MAP_DEFAULTS.maxDepth, timeoutMs: MAP_DEFAULTS.timeoutMs, budgetNotice: DEFAULT_MAP_BUDGET_NOTICE }),
	research: z.object({
		enabled: z.boolean().default(true).description("Register the `web_research` tool."),
		model: z.union(["mini", "pro"]).default(RESEARCH_DEFAULTS.model).description("Default Tavily research model when the model gives no `depth`; `pro` is slower and costs more credits."),
		pollIntervalMs: z.number().step(1).min(100).default(RESEARCH_DEFAULTS.pollIntervalMs).description("Interval between `GET /research/{id}` polls."),
		timeoutMs: z.number().step(1).min(1000).default(RESEARCH_DEFAULTS.timeoutMs).description("Give up polling after this many ms (the tool timeout adds 10 s of headroom)."),
		maxAnswerChars: z.number().step(1).min(500).default(RESEARCH_DEFAULTS.maxAnswerChars).description("Cap on the report returned to the model; sets `truncated: true`."),
		maxSources: z.number().step(1).min(1).default(RESEARCH_DEFAULTS.maxSources).description("Cap on the listed sources."),
		budgetPerSession: z.number().step(1).min(0).default(RESEARCH_DEFAULTS.budgetPerSession).description("web_research calls allowed per session (0 = unlimited)."),
		budgetNotice: z.string().default(DEFAULT_RESEARCH_BUDGET_NOTICE),
	}).default({ enabled: true, ...RESEARCH_DEFAULTS, budgetNotice: DEFAULT_RESEARCH_BUDGET_NOTICE }),
});

function nonEmpty(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Translate a (possibly hot-reloaded) config into client options.
 * @param {any} ctx
 * @param {any} config
 * @returns {import('./tavily-client.js').TavilyClientOptions}
 */
export function resolveClientOptions(ctx, config) {
	const apiKeyEnv = nonEmpty(config?.apiKeyEnv) ?? TAVILY_DEFAULT_API_KEY_ENV;
	const resolver = apiKeyResolver(ctx, { apiKey: config?.apiKey, apiKeyEnv });
	return {
		...(resolver.literal === undefined ? {} : { apiKey: resolver.literal }),
		resolveApiKey: () => resolver.resolve(),
		canResolveApiKey: () => resolver.canResolve(),
		apiKeyEnv,
		baseURL: nonEmpty(config?.baseURL) ?? TAVILY_DEFAULT_BASE_URL,
		timeoutMs: typeof config?.timeoutMs === "number" ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
		userAgent: DEFAULT_USER_AGENT,
	};
}

/**
 * Wire the plugin against `ctx` with explicit seams (used by tests).
 * @param {any} ctx
 * @param {any} config  validated plugin config
 * @param {{ current?: () => any, defineTool?: (d: any) => any }} [deps]
 */
export async function applyWith(ctx, config, deps = {}) {
	void bindHost(ctx); // make thrown errors genuine dsh-web WebError instances
	const current = deps.current ?? (() => config ?? {});
	const client = createTavilyClient({ resolveOptions: () => resolveClientOptions(ctx, current()) });
	const result = { client, provider: undefined, map: undefined, research: undefined };

	// `enabled` flags are read once at mount: registration is effect-scoped and
	// cannot be toggled live without remounting the row.
	if ((config?.extract?.enabled ?? true) !== false) {
		result.provider = new TavilyExtractFetchProvider(client, () => {
			const e = current()?.extract ?? {};
			return { depth: e.depth, maxOutputChars: e.maxOutputChars };
		});
		ctx.web.registerFetchProvider(result.provider);
	}

	if ((config?.map?.enabled ?? true) !== false) {
		const mapCfg = () => current()?.map ?? {};
		result.map = await applyWebMapTool(ctx, {
			client,
			config: mapCfg,
			budget: new SessionBudget(() => mapCfg().budgetPerSession ?? MAP_DEFAULTS.budgetPerSession),
			timeoutMs: config?.map?.timeoutMs ?? MAP_DEFAULTS.timeoutMs,
			...(deps.defineTool ? { defineTool: deps.defineTool } : {}),
		});
	}

	if ((config?.research?.enabled ?? true) !== false) {
		const researchCfg = () => current()?.research ?? {};
		result.research = await applyWebResearchTool(ctx, {
			client,
			config: researchCfg,
			budget: new SessionBudget(() => researchCfg().budgetPerSession ?? RESEARCH_DEFAULTS.budgetPerSession),
			timeoutMs: config?.research?.timeoutMs ?? RESEARCH_DEFAULTS.timeoutMs,
			...(deps.defineTool ? { defineTool: deps.defineTool } : {}),
		});
	}
	return result;
}

/** Cordis entry point. */
export async function apply(ctx, config) {
	const current = liveConfig(ctx, SETTINGS_NAMESPACE, Config, config);
	await applyWith(ctx, config, { current });
}

export { WEB_MAP_TOOL_NAME as TOOL_NAME, WEB_MAP_SECTION_NAME as SECTION_NAME };
