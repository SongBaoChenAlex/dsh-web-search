import http from "node:http";

/** Start a fake Tavily endpoint; `handler(req, body, res)` decides the reply. */
export async function startServer(handler) {
	const requests = [];
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => { raw += c; });
		req.on("end", () => {
			const body = raw.length > 0 ? JSON.parse(raw) : undefined;
			requests.push({ method: req.method, url: req.url, headers: req.headers, body });
			handler(req, body, res);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		baseURL: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
	};
}

export function json(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

/** Client options with a literal key pointing at `baseURL`. */
export function clientOptions(overrides = {}) {
	return {
		apiKey: "tvly-test",
		apiKeyEnv: "TAVILY_API_KEY",
		baseURL: "http://127.0.0.1:1",
		timeoutMs: 2_000,
		...overrides,
	};
}
