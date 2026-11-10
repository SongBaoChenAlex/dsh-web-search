/**
 * `@tobedone4byme/dsh-image-retention` — a DeepSeek Harness plugin that keeps only
 * the last `keepLast` image blocks in each outgoing model request. Every older
 * image (top-level user content and images nested inside tool-result blocks,
 * e.g. `read_image` output) is replaced with a short text placeholder.
 *
 * It is a request-time filter on the host-level `llm/stream` waterfall:
 * - the session event log is **not** rewritten, so earlier images stay in the
 *   GUI history and could be re-sent later by raising `keepLast`;
 * - it runs for the main agent and for every subagent (they all share `llm`);
 * - the only cost is the token budget saved on each request.
 *
 * The cordis waterfall re-reads the original (frozen) argument on `next()`,
 * so a filtered request cannot be threaded down the same chain. Instead the
 * listener vetoes the chain and re-dispatches the rewritten request through
 * `ctx.llm.stream`; a WeakSet guard makes that second pass a no-op here.
 *
 * `@deepseek-ai/dsh-llm` is resolved against the DSH installation through
 * `importHost` (a bare import from a plugin directory does not resolve); unit
 * tests inject `deps.llmModule` instead.
 *
 * @module @tobedone4byme/dsh-image-retention
 */
import z from "@deepseek-ai/schemastery";
import { importHost } from "@tobedone4byme/dsh-web-shared/host";

export const name = "image-retention";
export const inject = ["llm"];

export const Config = z.object({
	keepLast: z.number().step(1).min(0).default(1).description("Number of most recent images to keep in each model request; older ones become a text placeholder."),
	placeholder: z.string().default("[earlier image omitted from context]").description("Text substituted for every dropped image."),
	agentLoopOnly: z.boolean().default(true).description("Only filter requests assembled by the agent loop (skip title/compaction side calls)."),
	hoistToolResultImagesFor: z.array(z.string()).default(["github-copilot-official"]).description("Providers whose adapters reject images inside tool-result blocks. For these, surviving tool-result images are moved into a follow-up user message so the model still sees them."),
	hoistPlaceholder: z.string().default("[image returned by this tool is attached in the next user message]").description("Text left in a tool-result in place of each hoisted image.")
});

/**
 * Pure transform: move every image nested in a tool-result block out into a
 * new user message inserted right after the message that carried the
 * tool-results. OpenAI-style wire formats require `tool` messages to follow
 * the assistant `tool_calls` directly, so the images cannot be merged into the
 * same message; a trailing user message keeps the ordering valid.
 * @param {readonly any[]} messages
 * @param {string} placeholder
 * @returns {{ messages: readonly any[], hoisted: number }}
 */
export function hoistToolResultImages(messages, placeholder) {
	let hoisted = 0;
	/** @type {any[]} */
	const out = [];
	for (const message of messages) {
		const hasNested = message.role === "user" && message.content.some((b) => b.type === "tool-result" && Array.isArray(b.content) && hasImage(b.content));
		if (!hasNested) {
			out.push(message);
			continue;
		}
		/** @type {any[]} */
		const images = [];
		const content = message.content.map((block) => {
			if (block.type !== "tool-result" || !Array.isArray(block.content) || !hasImage(block.content)) return block;
			const inner = block.content.map((b) => {
				if (b.type !== "image") return b;
				images.push(b);
				hoisted += 1;
				return { type: "text", text: placeholder };
			});
			return { ...block, content: Object.freeze(inner) };
		});
		out.push(Object.freeze({ ...message, content: Object.freeze(content) }));
		out.push(Object.freeze({
			role: "user",
			source: message.source ?? { kind: "tool" },
			content: Object.freeze([{ type: "text", text: images.length === 1 ? "Image returned by the preceding tool call:" : `${images.length} images returned by the preceding tool call(s):` }, ...images])
		}));
	}
	return { messages: hoisted > 0 ? out : messages, hoisted };
}

/**
 * True when `blocks` contains an image, recursing into tool-result content.
 * @param {readonly any[]} blocks
 */
export function hasImage(blocks) {
	return blocks.some((b) => b.type === "image" || (b.type === "tool-result" && Array.isArray(b.content) && hasImage(b.content)));
}

/**
 * Count image blocks (recursing into tool-result content).
 * @param {readonly any[]} blocks
 * @returns {number}
 */
export function countImages(blocks) {
	let n = 0;
	for (const block of blocks) {
		if (block.type === "image") n += 1;
		else if (block.type === "tool-result" && Array.isArray(block.content)) n += countImages(block.content);
	}
	return n;
}

/**
 * Replace images in document order while `budget.drop > 0`.
 * @param {readonly any[]} blocks
 * @param {{ drop: number }} budget
 * @param {string} placeholder
 * @returns {any[]}
 */
function rewriteBlocks(blocks, budget, placeholder) {
	return blocks.map((block) => {
		if (budget.drop <= 0) return block;
		if (block.type === "image") {
			budget.drop -= 1;
			return { type: "text", text: placeholder };
		}
		if (block.type === "tool-result" && Array.isArray(block.content) && hasImage(block.content)) {
			return { ...block, content: rewriteBlocks(block.content, budget, placeholder) };
		}
		return block;
	});
}

/**
 * Pure transform: keep only the last `keepLast` images across `messages`.
 * Messages that are not touched keep their identity.
 * @param {readonly any[]} messages
 * @param {number} keepLast
 * @param {string} placeholder
 * @returns {{ messages: readonly any[], dropped: number }}
 */
export function retainLastImages(messages, keepLast, placeholder) {
	let total = 0;
	for (const message of messages) total += countImages(message.content);
	const drop = total - keepLast;
	if (drop <= 0) return { messages, dropped: 0 };
	const budget = { drop };
	const out = messages.map((message) => {
		if (budget.drop <= 0 || !hasImage(message.content)) return message;
		return Object.freeze({ ...message, content: Object.freeze(rewriteBlocks(message.content, budget, placeholder)) });
	});
	return { messages: out, dropped: drop };
}

/**
 * Register the `llm/stream` filter.
 * @param {any} ctx - cordis plugin context (needs `ctx.llm`, `ctx.on`, `ctx.logger`).
 * @param {Partial<z.infer<typeof Config>>} [config]
 * @param {{ llmModule?: Promise<any> }} [deps] - test seam for the dsh-llm import.
 */
export function applyWith(ctx, config, deps = {}) {
	const { keepLast, placeholder, agentLoopOnly, hoistToolResultImagesFor, hoistPlaceholder } = Config(config ?? {});
	const hoistProviders = new Set(hoistToolResultImagesFor);
	const llmModule = deps.llmModule ?? importHost(ctx, "@deepseek-ai/dsh-llm").then((mod) => {
		if (mod === undefined) ctx.logger.warn("image-retention: @deepseek-ai/dsh-llm not resolvable; treating every request as eligible");
		return mod;
	});
	/** Requests we already rewrote; the re-entrant dispatch must pass straight through. */
	const rewritten = new WeakSet();

	ctx.on("llm/stream", (options, next) => {
		if (rewritten.has(options)) return next();
		if (!Array.isArray(options.messages) || !options.messages.some((m) => hasImage(m.content))) return next();
		const retained = retainLastImages(options.messages, keepLast, placeholder);
		let { messages } = retained;
		const { dropped } = retained;
		let hoisted = 0;
		if (hoistProviders.has(options.provider)) ({ messages, hoisted } = hoistToolResultImages(messages, hoistPlaceholder));
		if (dropped === 0 && hoisted === 0) return next();

		// Async gate on the lazily imported dsh-llm helpers, then re-dispatch.
		return (async function* () {
			const llm = await llmModule;
			const isLoop = llm?.isAgentLoopRequest ? llm.isAgentLoopRequest(options) : true;
			if (agentLoopOnly && !isLoop && hoisted === 0) {
				yield* next();
				return;
			}
			if (agentLoopOnly && !isLoop) messages = hoistToolResultImages(options.messages, hoistPlaceholder).messages;
			if (dropped > 0) ctx.logger.debug(`image-retention: dropped ${dropped} older image(s), kept ${keepLast}`);
			if (hoisted > 0) ctx.logger.debug(`image-retention: hoisted ${hoisted} tool-result image(s) into user messages for provider ${options.provider}`);
			const request = { ...options, messages };
			if (isLoop && llm?.markAgentLoopRequest) llm.markAgentLoopRequest(request);
			const frozen = Object.isFrozen(options) && llm?.deepFreeze ? llm.deepFreeze(request) : request;
			rewritten.add(frozen);
			yield* ctx.llm.stream(frozen);
		})();
	}, { prepend: true });
}

/**
 * Cordis plugin entry.
 * @param {any} ctx
 * @param {Partial<z.infer<typeof Config>>} [config]
 */
export function apply(ctx, config) {
	applyWith(ctx, config);
}
