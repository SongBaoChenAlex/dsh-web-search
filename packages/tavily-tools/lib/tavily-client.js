/**
 * Minimal Tavily HTTP client shared by the `tavily-extract` fetch provider and
 * the `web_map` tool. One place for: the `Authorization: Bearer` header,
 * `fetchWithTimeout`, HTTP-status → message mapping (same wording as the
 * search adapter in `@tobedone4byme/dsh-web-search-http`), and abort / timeout →
 * `WebError` code mapping.
 *
 * Endpoints (https://docs.tavily.com/documentation/api-reference/endpoint/extract, …/map):
 * - `POST /extract` `{ urls: string[], extract_depth, format, include_images }`
 *   → `{ results: [{ url, raw_content }], failed_results: [{ url, error }], response_time }`
 * - `POST /map` `{ url, max_depth, max_breadth, limit, instructions?, select_paths?,
 *   select_domains?, exclude_paths?, exclude_domains?, allow_external? }`
 *   → `{ base_url, results: string[], response_time }`
 * - `POST /research` `{ input, model: "mini" | "pro" }`
 *   → `{ request_id, status: "pending", input, model, created_at }`
 * - `GET /research/{request_id}` → `{ status, content?, sources?, response_time?, … }`
 *
 * Error codes: `WEB_PROVIDER_ERROR` (HTTP / network / timeout),
 * `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_ABORTED` (caller abort).
 *
 * @module @tobedone4byme/dsh-web-tavily-tools/tavily-client
 */
import { fetchWithTimeout, abortable, isAbortError, webError } from "@tobedone4byme/dsh-web-shared/http";

export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
export const TAVILY_DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_USER_AGENT = "dsh-web-tavily-tools/0.1.0";
/** Tavily's documented ceiling for `urls` per extract call. */
export const EXTRACT_MAX_URLS = 20;

/**
 * Options the client resolves once per call (so a live settings change never
 * mixes inside one request).
 *
 * @typedef {object} TavilyClientOptions
 * @property {string} [apiKey]                              Literal key; wins over `resolveApiKey`.
 * @property {() => Promise<string | undefined>} [resolveApiKey]
 * @property {() => boolean} [canResolveApiKey]             Cheap sync check for `available()`.
 * @property {string} [apiKeyEnv]                           Name quoted in error messages.
 * @property {string} [baseURL]
 * @property {number} [timeoutMs]                           `0` disables.
 * @property {string} [userAgent]
 */

/**
 * @typedef {object} ExtractOptions
 * @property {'basic' | 'advanced'} [extractDepth]
 * @property {'markdown' | 'text'} [format]
 */

/**
 * @typedef {object} ExtractResponse
 * @property {Array<{ url: string, rawContent: string }>} results
 * @property {Array<{ url: string, error: string }>} failedResults
 * @property {number} [responseTime]
 */

/**
 * @typedef {object} MapOptions
 * @property {number} [maxDepth]        1–5 (Tavily); callers clamp further.
 * @property {number} [maxBreadth]
 * @property {number} [limit]
 * @property {string} [instructions]
 * @property {string[]} [selectPaths]
 * @property {string[]} [selectDomains]
 * @property {string[]} [excludePaths]
 * @property {string[]} [excludeDomains]
 * @property {boolean} [allowExternal]
 */

/**
 * @typedef {object} MapResponse
 * @property {string} baseUrl
 * @property {string[]} urls
 * @property {number} [responseTime]
 */

/**
 * @typedef {object} ResearchOptions
 * @property {'mini' | 'pro'} [model]  defaults to `mini`.
 */

/**
 * @typedef {object} ResearchStartResponse
 * @property {string} requestId
 * @property {string} status       normally `pending`
 * @property {string} [createdAt]
 */

/**
 * Raw `GET /research/{id}` body. `content` / `sources` are present once
 * `status === "completed"`.
 * @typedef {object} ResearchStatusResponse
 * @property {string} status       `pending` | `in_progress` | `completed` | `failed` | …
 * @property {string} [content]    Markdown report with inline `[n]` citations
 * @property {Array<{ url: string, title?: string }>} [sources]
 * @property {string} [request_id]
 * @property {number} [response_time]
 */

/**
 * Human-readable message for a non-2xx Tavily response. Mirrors
 * `search-http/lib/adapters/tavily.js#describeError` so users see one wording.
 * @param {number} status
 * @param {unknown} json  parsed error body (object, string or undefined)
 * @param {{ apiKeyEnv?: string, operation?: string }} [options]
 */
export function describeTavilyError(status, json, options = {}) {
	const env = options.apiKeyEnv ?? TAVILY_DEFAULT_API_KEY_ENV;
	const op = options.operation ? `Tavily ${options.operation}` : "Tavily";
	let message;
	switch (status) {
		case 401:
		case 403:
			message = `${op} rejected the API key (HTTP ${status}); check the "${env}" credential`;
			break;
		case 429:
			message = `${op} rate limit reached (HTTP 429); slow down or upgrade the plan`;
			break;
		case 432:
			message = `${op} plan usage limit exceeded (HTTP 432); the monthly credit quota is exhausted`;
			break;
		case 400:
		case 422:
			message = `${op} rejected the request (HTTP ${status})`;
			break;
		default:
			message = `${op} API error (HTTP ${status})`;
	}
	const detail = extractDetail(json);
	return detail !== undefined ? `${message}: ${detail}` : message;
}

/** Tavily error bodies are `{ detail: { error } }`, `{ detail }`, `{ error }` or `{ message }`. */
function extractDetail(json) {
	if (json === undefined || json === null) return undefined;
	if (typeof json === "string") return json.trim() || undefined;
	const candidates = [json.detail?.error, json.detail, json.error, json.message];
	for (const c of candidates) {
		if (typeof c === "string" && c.trim().length > 0) return c.trim();
	}
	return undefined;
}

function joinUrl(base, path) {
	return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function stringList(value) {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
	return out.length > 0 ? out : undefined;
}

function intIn(value, min, max, fallback) {
	const n = Math.trunc(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
}

async function readJsonLoosely(response) {
	const text = await response.text();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text.slice(0, 300);
	}
}

/** Resolves to a `WebError("WEB_ABORTED")`; always `await` it. */
function abortedError(signal, operation, fallback) {
	return webError(`Tavily ${operation} aborted`, "WEB_ABORTED", signal?.aborted === true ? signal.reason : fallback);
}

/**
 * @param {{ resolveOptions: () => TavilyClientOptions }} deps
 */
export function createTavilyClient({ resolveOptions }) {
	const options = () => {
		const o = resolveOptions() ?? {};
		return {
			...o,
			apiKeyEnv: o.apiKeyEnv ?? TAVILY_DEFAULT_API_KEY_ENV,
			baseURL: typeof o.baseURL === "string" && o.baseURL.trim().length > 0 ? o.baseURL.trim() : TAVILY_DEFAULT_BASE_URL,
			timeoutMs: typeof o.timeoutMs === "number" ? o.timeoutMs : DEFAULT_TIMEOUT_MS,
			userAgent: o.userAgent ?? DEFAULT_USER_AGENT,
		};
	};

	/** Cheap sync check: is a key plausibly resolvable and the base URL parseable? */
	function available() {
		const o = options();
		const hasKey = (o.apiKey?.length ?? 0) > 0
			|| (o.canResolveApiKey !== undefined ? o.canResolveApiKey() : o.resolveApiKey !== undefined);
		return hasKey && URL.canParse(o.baseURL);
	}

	async function apiKey(o, signal, operation) {
		if (o.apiKey !== undefined && o.apiKey.length > 0) return o.apiKey;
		let resolved;
		try {
			resolved = await abortable(o.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw await abortedError(signal, operation, error);
			throw await webError(`Tavily ${operation} credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
		if (typeof resolved === "string" && resolved.length > 0) return resolved;
		throw await webError(
			`Tavily ${operation} has no API key for "${o.apiKeyEnv}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-tavily-tools settings/config`,
			"WEB_PROVIDER_CREDENTIAL_MISSING",
		);
	}

	/**
	 * Send a JSON request to a Tavily endpoint and return the parsed body.
	 * @param {'GET' | 'POST'} method
	 * @param {string} path       e.g. "/extract"
	 * @param {object | undefined} body   JSON body (POST only)
	 * @param {AbortSignal} [signal]
	 * @param {string} operation  label for messages ("extract" | "map" | "research")
	 */
	async function request(method, path, body, signal, operation) {
		const o = options();
		if (signal?.aborted === true) throw await abortedError(signal, operation);
		const key = await apiKey(o, signal, operation);
		if (signal?.aborted === true) throw await abortedError(signal, operation);
		const url = joinUrl(o.baseURL, path);

		let response;
		try {
			response = await fetchWithTimeout(url, {
				method,
				redirect: "error",
				headers: {
					"authorization": `Bearer ${key}`,
					"accept": "application/json",
					"user-agent": o.userAgent,
					...(body !== undefined ? { "content-type": "application/json" } : {}),
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			}, { timeoutMs: o.timeoutMs, signal });
		} catch (error) {
			if (signal?.aborted === true || (isAbortError(error) && error?.name !== "TimeoutError")) throw await abortedError(signal, operation, error);
			if (error?.name === "TimeoutError") {
				throw await webError(`Tavily ${operation} timed out after ${o.timeoutMs} ms (endpoint ${url}); raise "timeoutMs" in the web-tavily-tools config or check connectivity`, "WEB_PROVIDER_ERROR", error);
			}
			throw await webError(`Tavily ${operation} request failed: ${String(error?.cause?.message ?? error?.message ?? error)}`, "WEB_PROVIDER_ERROR", error);
		}

		if (!response.ok) {
			let json;
			try {
				json = await readJsonLoosely(response);
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw await abortedError(signal, operation, error);
			}
			throw await webError(describeTavilyError(response.status, json, { apiKeyEnv: o.apiKeyEnv, operation }), "WEB_PROVIDER_ERROR");
		}

		try {
			return await response.json();
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw await abortedError(signal, operation, error);
			throw await webError(`Tavily ${operation} returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
	}

	const post = (path, body, signal, operation) => request("POST", path, body, signal, operation);
	const get = (path, signal, operation) => request("GET", path, undefined, signal, operation);

	/**
	 * `POST /extract`.
	 * @param {string[]} urls   1–20 absolute http(s) URLs
	 * @param {ExtractOptions} [opts]
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<ExtractResponse>}
	 */
	async function extract(urls, opts = {}, signal) {
		const list = (Array.isArray(urls) ? urls : [urls]).filter((u) => typeof u === "string" && u.trim().length > 0).map((u) => u.trim());
		if (list.length === 0) throw await webError("Tavily extract needs at least one URL", "WEB_PROVIDER_ERROR");
		if (list.length > EXTRACT_MAX_URLS) throw await webError(`Tavily extract accepts at most ${EXTRACT_MAX_URLS} URLs per call (got ${list.length})`, "WEB_PROVIDER_ERROR");
		const body = {
			urls: list,
			extract_depth: opts.extractDepth === "advanced" ? "advanced" : "basic",
			format: opts.format === "text" ? "text" : "markdown",
			include_images: false,
		};
		const json = await post("/extract", body, signal, "extract");
		const results = Array.isArray(json?.results) ? json.results : [];
		const failed = Array.isArray(json?.failed_results) ? json.failed_results : [];
		return {
			results: results
				.filter((r) => typeof r?.url === "string")
				.map((r) => ({ url: r.url, rawContent: typeof r.raw_content === "string" ? r.raw_content : "" })),
			failedResults: failed
				.filter((r) => typeof r?.url === "string")
				.map((r) => ({ url: r.url, error: typeof r.error === "string" && r.error.length > 0 ? r.error : "unknown error" })),
			...(typeof json?.response_time === "number" ? { responseTime: json.response_time } : {}),
		};
	}

	/**
	 * `POST /map`.
	 * @param {string} url
	 * @param {MapOptions} [opts]
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<MapResponse>}
	 */
	async function map(url, opts = {}, signal) {
		const root = typeof url === "string" ? url.trim() : "";
		if (root.length === 0) throw await webError("Tavily map needs a root URL", "WEB_PROVIDER_ERROR");
		const body = {
			url: root,
			max_depth: intIn(opts.maxDepth, 1, 5, 1),
			max_breadth: intIn(opts.maxBreadth, 1, 500, 20),
			limit: intIn(opts.limit, 1, 1000, 50),
		};
		if (typeof opts.instructions === "string" && opts.instructions.trim().length > 0) body.instructions = opts.instructions.trim();
		const selectPaths = stringList(opts.selectPaths);
		const selectDomains = stringList(opts.selectDomains);
		const excludePaths = stringList(opts.excludePaths);
		const excludeDomains = stringList(opts.excludeDomains);
		if (selectPaths) body.select_paths = selectPaths;
		if (selectDomains) body.select_domains = selectDomains;
		if (excludePaths) body.exclude_paths = excludePaths;
		if (excludeDomains) body.exclude_domains = excludeDomains;
		if (typeof opts.allowExternal === "boolean") body.allow_external = opts.allowExternal;

		const json = await post("/map", body, signal, "map");
		const urls = (Array.isArray(json?.results) ? json.results : [])
			.map((r) => (typeof r === "string" ? r : typeof r?.url === "string" ? r.url : ""))
			.map((u) => u.trim())
			.filter((u) => u.length > 0);
		return {
			baseUrl: typeof json?.base_url === "string" && json.base_url.length > 0 ? json.base_url : root,
			urls,
			...(typeof json?.response_time === "number" ? { responseTime: json.response_time } : {}),
		};
	}

	/**
	 * `POST /research` — start an asynchronous research job.
	 * @param {string} input   the research question
	 * @param {ResearchOptions} [opts]
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<ResearchStartResponse>}
	 */
	async function research(input, opts = {}, signal) {
		const question = typeof input === "string" ? input.trim() : "";
		if (question.length === 0) throw await webError("Tavily research needs a non-empty input", "WEB_PROVIDER_ERROR");
		const body = { input: question, model: opts.model === "pro" ? "pro" : "mini" };
		const json = await post("/research", body, signal, "research");
		const requestId = typeof json?.request_id === "string" ? json.request_id.trim() : "";
		if (requestId.length === 0) throw await webError("Tavily research did not return a request_id", "WEB_PROVIDER_ERROR");
		return {
			requestId,
			status: typeof json?.status === "string" ? json.status : "pending",
			...(typeof json?.created_at === "string" ? { createdAt: json.created_at } : {}),
		};
	}

	/**
	 * `GET /research/{request_id}` — poll a research job; returns the raw body.
	 * @param {string} requestId
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<ResearchStatusResponse>}
	 */
	async function researchStatus(requestId, signal) {
		const id = typeof requestId === "string" ? requestId.trim() : "";
		if (id.length === 0) throw await webError("Tavily research status needs a request id", "WEB_PROVIDER_ERROR");
		const json = await get(`/research/${encodeURIComponent(id)}`, signal, "research");
		if (json === null || typeof json !== "object" || Array.isArray(json)) {
			throw await webError("Tavily research status returned a non-object body", "WEB_PROVIDER_ERROR");
		}
		return json;
	}

	return { available, extract, map, research, researchStatus, options };
}
