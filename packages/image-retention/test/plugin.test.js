import { describe, expect, it, vi } from "vitest";
import { applyWith } from "../lib/index.js";

const img = (id) => ({ type: "image", attachment: { id, mediaType: "image/png" } });
const text = (t) => ({ type: "text", text: t });
const user = (...content) => ({ role: "user", source: { kind: "user" }, content });

async function* chunks(tag) {
	yield { type: "text-delta", index: 0, text: tag };
}

function fakeCtx(llmStream) {
	const listeners = [];
	return {
		on(event, fn, opts) {
			listeners.push({ event, fn, opts });
			return () => {};
		},
		logger: { debug: vi.fn(), warn: vi.fn() },
		llm: { stream: llmStream },
		listeners
	};
}

const fakeLlm = {
	isAgentLoopRequest: (r) => r.__loop === true,
	markAgentLoopRequest: (r) => { r.__loop = true; return r; },
	deepFreeze: (v) => Object.freeze(v)
};

async function collect(stream) {
	const out = [];
	for await (const c of stream) out.push(c);
	return out;
}

describe("image-retention plugin", () => {
	it("re-dispatches a filtered request through ctx.llm.stream and passes the second time", async () => {
		const seen = [];
		const ctx = fakeCtx((req) => {
			seen.push(req);
			// simulate the waterfall re-entering our own listener
			return ctx.listeners[0].fn(req, () => chunks("inner"));
		});
		applyWith(ctx, { keepLast: 1, placeholder: "[x]" }, { llmModule: Promise.resolve(fakeLlm) });
		expect(ctx.listeners[0].event).toBe("llm/stream");
		expect(ctx.listeners[0].opts).toEqual({ prepend: true });

		const options = { provider: "p", model: "m", messages: [user(img("1")), user(img("2"))], __loop: true };
		const next = vi.fn(() => chunks("outer"));
		const out = await collect(ctx.listeners[0].fn(options, next));

		expect(next).not.toHaveBeenCalled();
		expect(out).toEqual([{ type: "text-delta", index: 0, text: "inner" }]);
		expect(seen).toHaveLength(1);
		expect(seen[0].messages[0].content).toEqual([text("[x]")]);
		expect(seen[0].messages[1].content).toEqual([img("2")]);
		expect(seen[0].__loop).toBe(true);
	});

	it("passes through when no image needs dropping", async () => {
		const ctx = fakeCtx(vi.fn());
		applyWith(ctx, { keepLast: 1 }, { llmModule: Promise.resolve(fakeLlm) });
		const next = vi.fn(() => chunks("outer"));
		const out = await collect(ctx.listeners[0].fn({ messages: [user(img("1"))], __loop: true }, next));
		expect(next).toHaveBeenCalledOnce();
		expect(ctx.llm.stream).not.toHaveBeenCalled();
		expect(out[0].text).toBe("outer");
	});

	it("skips non-agent-loop requests when agentLoopOnly", async () => {
		const ctx = fakeCtx(vi.fn());
		applyWith(ctx, { keepLast: 0 }, { llmModule: Promise.resolve(fakeLlm) });
		const next = vi.fn(() => chunks("outer"));
		const out = await collect(ctx.listeners[0].fn({ messages: [user(img("1"))] }, next));
		expect(next).toHaveBeenCalledOnce();
		expect(ctx.llm.stream).not.toHaveBeenCalled();
		expect(out[0].text).toBe("outer");
	});

	it("hoists tool-result images into a follow-up user message for listed providers", async () => {
		const seen = [];
		const ctx = fakeCtx((req) => {
			seen.push(req);
			return ctx.listeners[0].fn(req, () => chunks("inner"));
		});
		applyWith(ctx, { keepLast: 5, hoistPlaceholder: "[h]" }, { llmModule: Promise.resolve(fakeLlm) });
		const toolMsg = { role: "user", source: { kind: "tool" }, content: [{ type: "tool-result", toolCallId: "c1", content: [text("ok"), img("1")] }] };
		const options = { provider: "github-copilot-official", model: "m", messages: [toolMsg], __loop: true };
		const next = vi.fn(() => chunks("outer"));
		await collect(ctx.listeners[0].fn(options, next));

		expect(next).not.toHaveBeenCalled();
		expect(seen).toHaveLength(1);
		const [m0, m1] = seen[0].messages;
		expect(m0.content[0].content).toEqual([text("ok"), text("[h]")]);
		expect(m1.role).toBe("user");
		expect(m1.content[1]).toEqual(img("1"));
	});

	it("leaves tool-result images alone for other providers", async () => {
		const ctx = fakeCtx(vi.fn());
		applyWith(ctx, { keepLast: 5 }, { llmModule: Promise.resolve(fakeLlm) });
		const toolMsg = { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [img("1")] }] };
		const next = vi.fn(() => chunks("outer"));
		await collect(ctx.listeners[0].fn({ provider: "deepseek", messages: [toolMsg], __loop: true }, next));
		expect(next).toHaveBeenCalledOnce();
	});
});
