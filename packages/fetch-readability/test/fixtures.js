import http from "node:http";

/** A long-ish article wrapped in site chrome. Readability should keep only the article. */
export const ARTICLE_PARAGRAPHS = Array.from({ length: 14 }, (_, i) =>
	`<p>Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog while the committee deliberates at length about the merits of streaming parsers, byte caps, and the surprisingly subtle question of what counts as an article on the modern web. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3)}</p>`,
);

const MENU = Array.from({ length: 40 }, (_, i) => `<li class="menu-item menu-item-${i}"><a class="nav-link" data-track="menu:${i}" href="/section/${i}">Section ${i}</a></li>`).join("");
const RELATED = Array.from({ length: 20 }, (_, i) => `<li class="card"><a href="/post/${i}?utm_source=sidebar"><img src="/img/${i}.jpg" alt=""><span class="card-title">Related post number ${i} you might also like</span></a></li>`).join("");
const JSON_LD = JSON.stringify({ "@context": "https://schema.org", "@type": "NewsArticle", headline: "Streaming Parsers Considered Delightful", author: { "@type": "Person", name: "A. Author" }, keywords: Array.from({ length: 50 }, (_, i) => `keyword${i}`) });

export const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Streaming Parsers Considered Delightful — Example Blog</title>
<style>body{font:16px sans-serif} .x{color:red} ${".cls-" + Array.from({ length: 80 }, (_, i) => `${i}{margin:0;padding:${i}px}`).join(" .cls-")}</style>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','UA-00000000-1');(function(){for(var i=0;i<1000;i++){}})();</script>
<script type="application/ld+json">${JSON_LD}</script>
<link rel="stylesheet" href="/site.css">
</head>
<body class="post-template">
<div id="cookie-banner" aria-hidden="true"><p>We use cookies. COOKIEMARKER</p><button>Accept</button></div>
<header role="banner"><a href="/">Example Blog</a><div class="promo">SUBSCRIBE TO OUR NEWSLETTER NOW</div>
<form action="/search"><input name="q" placeholder="Search"><button>Go</button></form></header>
<nav class="menu"><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li><li><a href="/archive">NAVMARKER_ARCHIVE</a></li>${MENU}</ul></nav>
<aside class="sidebar"><h3>Related</h3><ul><li><a href="/a">SIDEBARMARKER one</a></li>${RELATED}</ul></aside>
<main>
<article>
<h1>Streaming Parsers Considered Delightful</h1>
<p class="byline">By A. Author · 2024-01-01</p>
${ARTICLE_PARAGRAPHS.join("\n")}
<h2>Conclusion</h2>
<p>In conclusion, FINALMARKER the article body ends here with a sufficiently long closing paragraph so that extraction has something to hold on to.</p>
</article>
</main>
<footer><p>FOOTERMARKER © 2024 Example Blog · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p><ul>${MENU}</ul></footer>
<script src="/analytics.js"></script>
<script>console.log("more junk");${"var pad='" + "x".repeat(2000) + "';"}</script>
</body>
</html>`;

/** A link farm / index page: no article body for Readability to find. */
export const NON_ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Index of Things</title><script>var a=1;</script><style>.a{}</style></head>
<body>
<nav><a href="/x">NAVMARKER</a></nav>
<ul>
${Array.from({ length: 30 }, (_, i) => `<li><a href="/item/${i}">Item ${i}</a></li>`).join("\n")}
</ul>
<footer>FOOTERMARKER</footer>
</body></html>`;

/** "中文" in GBK/GB2312 is d6 d0 ce c4. */
export const GB2312_BYTES = Buffer.concat([
	Buffer.from("<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=gb2312\"><title>", "latin1"),
	Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
	Buffer.from("</title></head><body><p>", "latin1"),
	Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
	Buffer.from(" GBMARKER</p></body></html>", "latin1"),
]);

/**
 * Start a local fixture server. `routes` maps pathname → handler(req, res) or
 * a static `{ status, headers, body }`.
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startFixtureServer(routes) {
	const server = http.createServer((req, res) => {
		const path = new URL(req.url, "http://127.0.0.1").pathname;
		const route = routes[path] ?? routes["*"];
		if (route === undefined) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end(`no route for ${path}`);
			return;
		}
		if (typeof route === "function") {
			route(req, res);
			return;
		}
		res.writeHead(route.status ?? 200, route.headers ?? { "content-type": "text/html; charset=utf-8" });
		res.end(route.body ?? "");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		close: () => new Promise((resolve) => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		}),
	};
}

/** Resolver that pretends everything is a public host unless mapped otherwise. */
export function fakeLookup(map = {}) {
	return async (host) => {
		if (map[host] !== undefined) return map[host];
		if (host === "127.0.0.1") return ["127.0.0.1"];
		return ["93.184.216.34"];
	};
}
