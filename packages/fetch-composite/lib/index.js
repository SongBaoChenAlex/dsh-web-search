/**
 * `composite` — a `web_fetch` provider for the DeepSeek Harness web seam that
 * chains other registered fetch providers.
 *
 * Try the first provider in `chain`; when its result is *thin* (too little
 * visible text — SPA shells, consent walls, PDFs rendered as nothing), its
 * status is in `fallbackOnStatus` (403/429/… anti-bot), or it throws, move on
 * to the next one. The typical chain is `readability-http` (local, free) →
 * `tavily-extract` (hosted, costs credits, renders JS and reads PDFs), so the
 * expensive provider is only paid for when the cheap one actually failed.
 *
 * Providers are resolved lazily at call time from `ctx.web.fetchProviders`, so
 * registration order between plugin rows does not matter.
 *
 * @module @tobedone4byme/dsh-web-fetch-composite
 */
import z from "@deepseek-ai/schemastery";
import { bindHost, isAbortError, throwIfAborted, webError } from "@tobedone4byme/dsh-web-shared/http";
import { liveConfig } from "@tobedone4byme/dsh-web-shared/settings";

/** Stable id this provider registers under (select it via the `web` row's `fetchProvider`). */
export const COMPOSITE_FETCH_PROVIDER_ID = "composite";

export const DEFAULT_CHAIN = ["readability-http", "tavily-extract"];
export const DEFAULT_FALLBACK_STATUS = [403, 429, 451, 500, 502, 503];

export const DEFAULTS = Object.freeze({
	chain: DEFAULT_CHAIN,
	minTextChars: 400,
	fallbackOnStatus: DEFAULT_FALLBACK_STATUS,
	fallbackOnError: true,
	notice: true,
});

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-fetch-composite";
/** The web seam this provider registers into. */
export const inject = ["web"];

export const Config = z.object({
	chain: z.array(z.string()).default([...DEFAULT_CHAIN]).description("Fetch provider ids to try in order. Missing / unavailable ids and `composite` itself are skipped."),
	minTextChars: z.number().step(1).min(0).default(DEFAULTS.minTextChars).description("A result whose visible text is shorter than this is 'thin' and triggers the next provider. 0 disables."),
	fallbackOnStatus: z.array(z.number().step(1)).default([...DEFAULT_FALLBACK_STATUS]).description("HTTP status codes that trigger the next provider."),
	fallbackOnError: z.boolean().default(DEFAULTS.fallbackOnError).description("Try the next provider when the current one throws (aborts always propagate)."),
	notice: z.boolean().default(DEFAULTS.notice).description("Prepend a one-line note naming the provider that served the page after a fallback."),
});

export const SETTINGS_NAMESPACE = "web-fetch-composite";

/**
 * Length of the visible text of a fetch result: tags, scripts, styles and
 * entities stripped and whitespace collapsed for `html`; trimmed/collapsed raw
 * content for `text`.
 * @param {{ body?: { kind?: string, content?: string } } | null | undefined} result
 * @returns {number}
 */
export function textLengthOf(result) {
	const content = String(result?.body?.content ?? "");
	if (content.length === 0) return 0;
	let text = content;
	if (result?.body?.kind === "html") {
		text = text
			.replace(/<!--[\s\S]*?-->/gu, " ")
			.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/giu, " ")
			.replace(/<[^>]+>/gu, " ")
			.replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/giu, " ");
	}
	return text.replace(/\s+/gu, " ").trim().length;
}

/**
 * True when the result carries fewer than `minTextChars` visible characters.
 * @param {{ body?: { kind?: string, content?: string } } | null | undefined} result
 * @param {number} minTextChars
 */
export function isThin(result, minTextChars) {
	if (!Number.isFinite(minTextChars) || minTextChars <= 0) return false;
	return textLengthOf(result) < minTextChars;
}

/**
 * Prepend the provenance notice to a copy of the result (the body is the only
 * field changed).
 * @param {import('@deepseek-ai/dsh-web').WebFetchResult} result
 * @param {string} line
 */
function withNotice(result, line) {
	const kind = result.body?.kind;
	const content = String(result.body?.content ?? "");
	const prefix = kind === "html" ? `<!-- ${line} -->` : `[${line}]`;
	return { ...result, body: { ...result.body, content: `${prefix}\n${content}` } };
}

/**
 * The chaining fetch provider.
 * @implements {import('@deepseek-ai/dsh-web').WebFetchProvider}
 */
export class CompositeFetchProvider {
	id = COMPOSITE_FETCH_PROVIDER_ID;

	/**
	 * @param {{ fetchProviders?: Map<string, any> } | undefined} web  the `ctx.web` seam (looked up lazily on every call).
	 * @param {() => Partial<typeof DEFAULTS>} [resolveOptions]
	 *   thunk resolved once per fetch so settings changes never mix mid-flight.
	 */
	constructor(web, resolveOptions = () => ({})) {
		this.web = web;
		this.resolveOptions = resolveOptions;
	}

	/** @returns {typeof DEFAULTS} */
	options() {
		return { ...DEFAULTS, ...stripUndefined(this.resolveOptions()) };
	}

	/**
	 * Resolve the usable members of the chain right now.
	 * @returns {Array<{ id: string, provider: any }>}
	 */
	resolveChain() {
		const registry = this.web?.fetchProviders;
		const out = [];
		const seen = new Set();
		for (const rawId of this.options().chain ?? []) {
			const id = String(rawId ?? "").trim();
			if (id.length === 0 || id === this.id || seen.has(id)) continue;
			seen.add(id);
			const provider = registry?.get?.(id);
			if (provider === undefined || provider === null || provider === this) continue;
			let ok = false;
			try {
				ok = typeof provider.available === "function" ? provider.available() === true : true;
			} catch {
				ok = false;
			}
			if (ok) out.push({ id, provider });
		}
		return out;
	}

	available() {
		return this.resolveChain().length > 0;
	}

	/**
	 * @param {{ url: string }} request
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<import('@deepseek-ai/dsh-web').WebFetchResult>}
	 */
	async fetch(request, signal) {
		const options = this.options();
		const chain = this.resolveChain();
		const url = String(request?.url ?? "");
		if (chain.length === 0) {
			throw await webError(
				`composite fetch provider has no usable provider for ${url}: none of [${(options.chain ?? []).join(", ")}] is registered and available`,
				"WEB_PROVIDER_ERROR",
			);
		}
		if (signal?.aborted === true) throw await aborted(signal);

		const statusSet = new Set((options.fallbackOnStatus ?? []).map(Number));
		/** @type {Array<{ id: string, result: any, length: number }>} */
		const thin = [];
		/** @type {Array<{ id: string, reason: string }>} */
		const failures = [];
		let lastError;

		for (let i = 0; i < chain.length; i++) {
			const { id, provider } = chain[i];
			if (i > 0) {
				try {
					throwIfAborted(signal, "web_fetch");
				} catch (error) {
					throw await aborted(signal, error);
				}
			}

			let result;
			try {
				result = await provider.fetch(request, signal);
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw await aborted(signal, error);
				if (options.fallbackOnError !== true) throw error;
				lastError = error;
				failures.push({ id, reason: `error: ${error?.message ?? String(error)}` });
				continue;
			}

			const status = Number(result?.statusCode);
			if (statusSet.has(status)) {
				failures.push({ id, reason: `HTTP ${status}` });
				continue;
			}

			const length = textLengthOf(result);
			if (isThin(result, options.minTextChars)) {
				thin.push({ id, result, length });
				failures.push({ id, reason: `thin content (${length} chars)` });
				continue;
			}

			return this.decorate(result, id, failures, options);
		}

		if (thin.length > 0) {
			// Everyone came back thin: hand over the longest attempt, not the last.
			let best = thin[0];
			for (const t of thin) if (t.length > best.length) best = t;
			const others = failures.filter((f) => f.id !== best.id || !f.reason.startsWith("thin"));
			return this.decorate(best.result, best.id, others, options, "all providers thin");
		}

		const detail = failures.map((f) => `${f.id}: ${f.reason}`).join("; ");
		throw await webError(`web_fetch of ${url} failed in every provider (${detail})`, "WEB_PROVIDER_ERROR", lastError);
	}

	/**
	 * Attach the provenance notice when a fallback happened.
	 * @param {any} result
	 * @param {string} servedBy
	 * @param {Array<{ id: string, reason: string }>} failures  earlier attempts
	 * @param {typeof DEFAULTS} options
	 * @param {string} [suffix]
	 */
	decorate(result, servedBy, failures, options, suffix) {
		if (options.notice !== true || (failures.length === 0 && suffix === undefined)) return result;
		const primary = failures[0];
		let line = `fetched via ${servedBy}`;
		if (primary !== undefined) line += ` after ${primary.id} returned ${primary.reason}`;
		if (suffix !== undefined) line += ` (${suffix})`;
		line = line.replace(/[\r\n]+/gu, " ").replace(/--/gu, "-").slice(0, 300);
		return withNotice(result, line);
	}
}

function stripUndefined(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v;
	return out;
}

async function aborted(signal, cause) {
	return webError("web_fetch aborted", "WEB_ABORTED", signal?.aborted === true ? signal.reason : cause);
}

/**
 * Register the provider with `ctx.web`; config is hot-reloadable through the
 * `web-fetch-composite:` section of `~/.dsh/settings.yaml`.
 */
export function apply(ctx, config) {
	void bindHost(ctx); // make thrown errors genuine dsh-web WebError instances
	const current = liveConfig(ctx, SETTINGS_NAMESPACE, Config, config);
	ctx.web.registerFetchProvider(new CompositeFetchProvider(ctx.web, () => current()));
}
