import { describe, expect, it } from "vitest";
import { countImages, retainLastImages } from "../lib/index.js";

const img = (id) => ({ type: "image", attachment: { id, mediaType: "image/png" } });
const text = (t) => ({ type: "text", text: t });
const user = (...content) => ({ role: "user", source: { kind: "user" }, content });
const toolResult = (...content) => ({
	role: "user",
	source: { kind: "tool", callId: "c1" },
	content: [{ type: "tool-result", toolCallId: "c1", content }]
});

describe("retainLastImages", () => {
	it("keeps only the last image by default", () => {
		const messages = [user(text("a"), img("1")), user(img("2")), user(text("b"), img("3"))];
		const { messages: out, dropped } = retainLastImages(messages, 1, "[x]");
		expect(dropped).toBe(2);
		expect(out[0].content).toEqual([text("a"), text("[x]")]);
		expect(out[1].content).toEqual([text("[x]")]);
		expect(out[2].content).toEqual([text("b"), img("3")]);
		// untouched messages keep identity
		expect(out[2]).toBe(messages[2]);
	});

	it("recurses into tool-result images", () => {
		const messages = [toolResult(text("shot"), img("1")), user(img("2"))];
		const { messages: out, dropped } = retainLastImages(messages, 1, "[x]");
		expect(dropped).toBe(1);
		expect(out[0].content[0].content).toEqual([text("shot"), text("[x]")]);
		expect(out[1]).toBe(messages[1]);
	});

	it("is a no-op when within budget", () => {
		const messages = [user(img("1"))];
		const result = retainLastImages(messages, 1, "[x]");
		expect(result.dropped).toBe(0);
		expect(result.messages).toBe(messages);
	});

	it("keepLast 0 drops everything", () => {
		const messages = [user(img("1")), user(img("2"))];
		const { dropped } = retainLastImages(messages, 0, "[x]");
		expect(dropped).toBe(2);
		expect(countImages(retainLastImages(messages, 0, "[x]").messages.flatMap((m) => m.content))).toBe(0);
	});
});
