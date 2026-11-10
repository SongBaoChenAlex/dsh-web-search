/**
 * The `web_research` tool: delegate a multi-source question to Tavily
 * `/research`, which runs an agentic search → read → synthesize loop and
 * returns one Markdown report with inline `[n]` citations.
 *
 * It is the EXPENSIVE sibling of `web_search`: several credits and 15–120 s
 * per call, so it ships with a small per-session budget (default 2) and a
 * `mini` model default. The tool starts the job (`POST /research`) and polls
 * `GET /research/{id}` until a terminal status, the timeout, or an abort.
 *
 * `defineTool` comes from `@deepseek-ai/dsh-tools` and is resolved against the
 * DSH installation via `requireHost`; tests inject their own `defineTool`.
 *
 * @module @tobedone4byme/dsh-web-tavily-tools/research
 */
import { SessionBudget } from "./budget.js";
import { requireHost } from "@tobedone4byme/dsh-web-shared/host";
import { webError } from "@tobedone4byme/dsh-web-shared/http";

export const WEB_RESEARCH_TOOL_NAME = "web_research";
export const WEB_RESEARCH_SECTION_NAME = "tool:web_research";
/** Right after `tool:web_map` (112). */
export const WEB_RESEARCH_SECTION_ORDER = 113;

export const RESEARCH_DEFAULTS = Object.freeze({
	model: "mini",
	pollIntervalMs: 2_000,
	timeoutMs: 120_000,
	maxAnswerChars: 6_000,
	maxSources: 10,
	budgetPerSession: 2,
});

export const DEFAULT_RESEARCH_BUDGET_NOTICE =
	"web_research budget for this session is exhausted; this call was not performed. "
	+ "Answer from what you already have, or use web_search / web_fetch for specific facts.";

/** @param {number} budgetPerSession */
export function researchGuidance(budgetPerSession) {
	const n = Number(budgetPerSession);
	const budgetLine = Number.isFinite(n) && n > 0
		? `It is slow (15-120 s) and costs many credits, so it is budgeted: ${Math.floor(n)} call${Math.floor(n) === 1 ? "" : "s"} per session.`
		: "It is slow (15-120 s) and costs many credits; use it sparingly.";
	return "Use web_research only for questions that need synthesis across many sources (comparisons, state-of-the-art overviews, multi-part questions). "
		+ "For one fact or one page use web_search or web_fetch instead. "
		+ `${budgetLine} `
		+ "Prefer depth \"mini\"; use \"pro\" only when the user explicitly asks for exhaustive research.";
}

export const WEB_RESEARCH_GUIDANCE = researchGuidance(RESEARCH_DEFAULTS.budgetPerSession);

/** Session key for the budget bucket; `anonymous` for calls without an agent. */
export function sessionKeyOf(exec) {
	return exec?.agent?.session?.header?.id ?? "anonymous";
}

/** Statuses that mean "keep polling". Anything else is terminal. */
const PENDING_STATUSES = new Set(["pending", "in_progress"]);

function stripUndefined(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v;
	return out;
}

function positiveInt(value, fallback) {
	const n = Math.trunc(Number(value));
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeModel(value, fallback) {
	return value === "pro" || value === "mini" ? value : fallback === "pro" ? "pro" : "mini";
}

/**
 * Abortable sleep; rejects with `WEB_ABORTED` when `signal` fires.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			webError("Tavily research aborted", "WEB_ABORTED", signal.reason).then(reject, reject);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			webError("Tavily research aborted", "WEB_ABORTED", signal?.reason).then(reject, reject);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Normalize Tavily's `sources` into `{ url, title? }` and cap the list.
 * @param {unknown} raw
 * @param {number} max
 * @returns {Array<{ url: string, title?: string }>}
 */
export function shapeSources(raw, max) {
	if (!Array.isArray(raw)) return [];
	const seen = new Set();
	const out = [];
	for (const item of raw) {
		const url = typeof item === "string" ? item.trim() : typeof item?.url === "string" ? item.url.trim() : "";
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		const title = typeof item?.title === "string" && item.title.trim().length > 0 ? item.title.trim() : undefined;
		out.push(title !== undefined ? { url, title } : { url });
		if (out.length >= Math.max(1, max)) break;
	}
	return out;
}

/**
 * Cap `answer` at `maxChars`; returns the (possibly truncated) text and a flag.
 * @param {string} answer
 * @param {number} maxChars
 */
export function capAnswer(answer, maxChars) {
	const text = typeof answer === "string" ? answer : "";
	const limit = Math.max(1, maxChars);
	if (text.length <= limit) return { answer: text, truncated: false };
	return { answer: text.slice(0, limit).trimEnd(), truncated: true };
}

/**
 * Model-facing Markdown for a `web_research` value: the answer, then a
 * compact numbered "Sources" list.
 * @param {{ answer: string, sources: Array<{ url: string, title?: string }>, truncated: boolean, notice?: string }} value
 */
export function formatResearchOutput(value) {
	const answer = typeof value.answer === "string" ? value.answer.trim() : "";
	const notice = typeof value.notice === "string" && value.notice.length > 0 ? value.notice : undefined;
	if (answer.length === 0 && notice !== undefined) return notice;
	const parts = [answer.length > 0 ? answer : "(empty report)"];
	if (notice !== undefined) parts.push(notice);
	if (Array.isArray(value.sources) && value.sources.length > 0) {
		const lines = value.sources.map((s, i) => `${i + 1}. ${s.title ? `${s.title} — ` : ""}${s.url}`);
		parts.push(`Sources:\n${lines.join("\n")}`);
	}
	return parts.join("\n\n");
}

const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		answer: { type: "string", required: true },
		sources: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: { type: "string", required: true },
					title: { type: "string" },
				},
			},
		},
		truncated: { type: "boolean", required: true },
		notice: { type: "string" },
		requestId: { type: "string", required: true },
	},
};

export const WEB_RESEARCH_DESCRIPTION =
	"EXPENSIVE and SLOW: run a multi-step agentic web research job (Tavily Research) that searches many sources, "
	+ "reads them and returns one synthesized Markdown report with numbered citations. Costs several credits and takes 15-120 seconds, "
	+ "and only a few calls are allowed per session. Use it ONLY when a question genuinely needs synthesis across many sources "
	+ "(comparisons, overviews, multi-part questions). For a single fact or a known page use web_search or web_fetch instead.";

/**
 * Build the `defineTool` options object for `web_research` (pure; no registration).
 * @param {object} deps
 * @param {{ research: Function, researchStatus: Function }} deps.client
 * @param {() => Partial<typeof RESEARCH_DEFAULTS> & { budgetNotice?: string }} deps.config  thunk; re-read per call
 * @param {SessionBudget} deps.budget
 * @param {number} [deps.timeoutMs]  static tool timeout (defineTool requires a positive number)
 */
export function buildWebResearchToolDefinition({ client, config, budget, timeoutMs }) {
	const cfg = () => ({ ...RESEARCH_DEFAULTS, ...stripUndefined(config?.() ?? {}) });
	const pollDeadline = positiveInt(timeoutMs ?? cfg().timeoutMs, RESEARCH_DEFAULTS.timeoutMs);
	// Leave the cooperative tool timeout some headroom above our own polling deadline
	// so the tool can return a clean error rather than being killed mid-flight.
	const toolTimeout = pollDeadline + 10_000;
	return {
		name: WEB_RESEARCH_TOOL_NAME,
		description: WEB_RESEARCH_DESCRIPTION,
		parameters: {
			question: { type: "string", required: true, description: "The research question, fully self-contained (include names, versions, time frame)." },
			depth: { type: "string", enum: ["mini", "pro"], description: "\"mini\" (default, faster, cheaper) or \"pro\" (deeper, slower, more credits)." },
		},
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: "text", text: formatResearchOutput(value) }],
			presentationMeta: (_args, value) => ({
				requestId: value.requestId,
				sourceCount: Array.isArray(value.sources) ? value.sources.length : 0,
				truncated: value.truncated,
				answerChars: typeof value.answer === "string" ? value.answer.length : 0,
				...(value.notice !== undefined && value.answer === "" ? { budgetExhausted: true } : {}),
			}),
		},
		timeoutMs: toolTimeout,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const c = cfg();
			const question = String(args?.question ?? "").trim();
			if (question.length === 0) throw new Error("question must be a non-empty string");
			const signal = exec?.signal;

			const { allowed, used, limit } = budget.consume(sessionKeyOf(exec));
			if (!allowed) {
				const notice = typeof c.budgetNotice === "string" && c.budgetNotice.length > 0 ? c.budgetNotice : DEFAULT_RESEARCH_BUDGET_NOTICE;
				return { answer: "", sources: [], truncated: false, notice: `${notice} (${used}/${limit} used)`, requestId: "" };
			}

			const model = normalizeModel(args?.depth, c.model);
			const pollIntervalMs = positiveInt(c.pollIntervalMs, RESEARCH_DEFAULTS.pollIntervalMs);
			const deadlineMs = positiveInt(c.timeoutMs, pollDeadline);
			const maxAnswerChars = positiveInt(c.maxAnswerChars, RESEARCH_DEFAULTS.maxAnswerChars);
			const maxSources = positiveInt(c.maxSources, RESEARCH_DEFAULTS.maxSources);

			const started = Date.now();
			const { requestId } = await client.research(question, { model }, signal);

			let status;
			for (;;) {
				status = await client.researchStatus(requestId, signal);
				const state = typeof status?.status === "string" ? status.status : "";
				if (!PENDING_STATUSES.has(state)) break;
				const elapsed = Date.now() - started;
				if (elapsed >= deadlineMs) {
					throw await webError(
						`Tavily research ${requestId} did not finish within ${deadlineMs} ms (last status "${state}"); raise "research.timeoutMs" or try depth "mini"`,
						"WEB_PROVIDER_ERROR",
					);
				}
				await sleep(Math.min(pollIntervalMs, Math.max(1, deadlineMs - elapsed)), signal);
			}

			const state = typeof status?.status === "string" ? status.status : "unknown";
			if (state !== "completed") {
				const detail = [status?.error, status?.detail, status?.message].find((d) => typeof d === "string" && d.trim().length > 0);
				throw await webError(
					`Tavily research ${requestId} ended with status "${state}"${detail ? `: ${detail.trim()}` : ""}`,
					"WEB_PROVIDER_ERROR",
				);
			}

			const capped = capAnswer(status.content, maxAnswerChars);
			const sources = shapeSources(status.sources, maxSources);
			return {
				answer: capped.answer,
				sources,
				truncated: capped.truncated,
				...(capped.truncated ? { notice: `[truncated: report capped at ${maxAnswerChars} chars]` } : {}),
				requestId,
			};
		},
	};
}

/**
 * `defineTool` from the host, resolved against the DSH installation (a bare
 * `import("@deepseek-ai/dsh-tools")` from a plugin directory does NOT resolve).
 */
async function loadDefineTool(ctx) {
	const mod = await requireHost(ctx, "@deepseek-ai/dsh-tools");
	if (typeof mod.defineTool !== "function") throw new Error("@deepseek-ai/dsh-tools does not export defineTool");
	return mod.defineTool;
}

/**
 * Register `web_research` and its system-prompt section.
 * @param {any} ctx  needs `tools.register` and (optionally) `systemPrompt.section`
 * @param {object} deps
 * @param {any} deps.client
 * @param {() => any} deps.config    thunk returning the live `research` config section
 * @param {SessionBudget} [deps.budget]
 * @param {(definition: any) => any} [deps.defineTool]  override for tests
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{ budget: SessionBudget, definition: any, tool: any }>}
 */
export async function applyWebResearchTool(ctx, { client, config, budget, defineTool, timeoutMs }) {
	const cfg = typeof config === "function" ? config : () => config ?? {};
	const sessionBudget = budget ?? new SessionBudget(() => cfg().budgetPerSession ?? RESEARCH_DEFAULTS.budgetPerSession);
	const definition = buildWebResearchToolDefinition({ client, config: cfg, budget: sessionBudget, timeoutMs });

	try {
		if (ctx?.systemPrompt && typeof ctx.systemPrompt.section === "function") {
			const text = researchGuidance(cfg().budgetPerSession ?? RESEARCH_DEFAULTS.budgetPerSession);
			ctx.systemPrompt.section({ name: WEB_RESEARCH_SECTION_NAME, order: WEB_RESEARCH_SECTION_ORDER, text });
		}
	} catch (error) {
		ctx?.logger?.warn?.(`web-tavily-tools: could not register the web_research prompt section (${String(error)})`);
	}

	const define = defineTool ?? await loadDefineTool(ctx);
	const tool = define(definition);
	ctx.tools.register(tool);
	return { budget: sessionBudget, definition, tool };
}

export { SessionBudget };
