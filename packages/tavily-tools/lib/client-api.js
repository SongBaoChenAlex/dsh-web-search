/**
 * Static catalogue of Tavily API endpoints and how this monorepo maps them to
 * DSH surfaces. Consumed by docs and the provider-selector UI; no runtime
 * behaviour depends on it.
 * @module @tobedone4byme/dsh-web-tavily-tools/client-api
 */

/**
 * @typedef {object} TavilyEndpointInfo
 * @property {'search' | 'extract' | 'map' | 'crawl' | 'research' | 'research-status'} id
 * @property {string} path            Tavily REST path.
 * @property {string} summary
 * @property {string} costNote        Credit cost per Tavily's pricing page (verify before quoting to users).
 * @property {string} tokenNote       What it does to the model's context window.
 * @property {string | null} implementedBy   DSH surface, or `null` when intentionally not exposed.
 * @property {string} [reason]        Why it is not implemented (when `implementedBy` is null).
 */

/** @type {readonly TavilyEndpointInfo[]} */
export const TAVILY_ENDPOINTS = Object.freeze([
	{
		id: "search",
		path: "/search",
		summary: "LLM-native web search: ranked results with extracted passages and an optional synthesized answer.",
		costNote: "1 credit per basic search, 2 per advanced.",
		tokenNote: "Medium: answer + N snippets; governed by @tobedone4byme/dsh-web-search-governor.",
		implementedBy: "@tobedone4byme/dsh-web-search-http",
	},
	{
		id: "extract",
		path: "/extract",
		summary: "Fetch and clean one or more URLs (JS-rendered pages, PDFs) into Markdown or text.",
		costNote: "1 credit per 5 URLs at basic depth, 2 per 5 at advanced.",
		tokenNote: "High per call (full page); capped at maxOutputChars (default 20 000 chars).",
		implementedBy: "@tobedone4byme/dsh-web-tavily-tools (fetch provider tavily-extract)",
	},
	{
		id: "map",
		path: "/map",
		summary: "List the URLs under a site root, optionally filtered by natural-language instructions. No page bodies.",
		costNote: "1 credit per 10 pages mapped (basic); instructions-guided mapping costs more.",
		tokenNote: "Very low: one line per URL, capped at `limit` (default 30).",
		implementedBy: "web_map tool",
	},
	{
		id: "crawl",
		path: "/crawl",
		summary: "Map + extract in one call over a whole site.",
		costNote: "Map cost plus extract cost per page.",
		tokenNote: "Very high: dozens of full pages.",
		implementedBy: null,
		reason: "batch primitive; not model-facing",
	},
	{
		id: "research",
		path: "/research",
		summary: "Start an asynchronous agentic multi-step research job (`model: mini | pro`); returns a request_id.",
		costNote: "Variable, significantly higher than search (several credits per run; `pro` costs more than `mini`).",
		tokenNote: "One Markdown report with citations; replaces many search + fetch rounds. Capped at `maxAnswerChars` (default 6 000).",
		implementedBy: "web_research tool",
	},
	{
		id: "research-status",
		path: "/research/{request_id}",
		summary: "Poll a research job: `pending` | `in_progress` | `completed` (with `content` + `sources`) | `failed`.",
		costNote: "Free; the cost is charged by `POST /research`.",
		tokenNote: "None (polled internally by web_research).",
		implementedBy: "web_research tool",
	},
]);

/** @param {string} id */
export function tavilyEndpoint(id) {
	return TAVILY_ENDPOINTS.find((e) => e.id === id);
}
