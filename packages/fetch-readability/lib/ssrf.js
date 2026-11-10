/**
 * SSRF guard for the fetch provider. Pure helpers plus one async
 * `assertSafeUrl` that resolves DNS (injectable for tests) and refuses any
 * target that lands on a private, loopback, link-local or otherwise
 * non-public address.
 * @module @baoson/dsh-web-fetch-readability/ssrf
 */
import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** URL schemes the provider will fetch. */
export const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Thrown by {@link assertSafeUrl}. Carries a short `reason` suitable for a
 * user-facing message; the provider wraps it in a `WebError`.
 */
export class BlockedUrlError extends Error {
	/**
	 * @param {string} url
	 * @param {string} reason
	 */
	constructor(url, reason) {
		super(`Blocked URL ${url}: ${reason}`);
		this.name = "BlockedUrlError";
		this.url = url;
		this.reason = reason;
	}
}

const v4Blocks = new BlockList();
for (const [addr, prefix] of [
	["0.0.0.0", 8], // "this" network
	["10.0.0.0", 8], // RFC 1918
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local / cloud metadata
	["172.16.0.0", 12], // RFC 1918
	["192.0.0.0", 24], // IETF protocol assignments
	["192.168.0.0", 16], // RFC 1918
	["198.18.0.0", 15], // benchmarking
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved + broadcast (255.255.255.255)
]) v4Blocks.addSubnet(addr, prefix, "ipv4");

const v6Blocks = new BlockList();
v6Blocks.addAddress("::", "ipv6"); // unspecified
v6Blocks.addAddress("::1", "ipv6"); // loopback
v6Blocks.addSubnet("fc00::", 7, "ipv6"); // unique local
v6Blocks.addSubnet("fe80::", 10, "ipv6"); // link-local
v6Blocks.addSubnet("ff00::", 8, "ipv6"); // multicast

/**
 * @param {string | URL} url
 * @returns {boolean} true for http(s) URLs only.
 */
export function isAllowedScheme(url) {
	try {
		const u = typeof url === "string" ? new URL(url) : url;
		return ALLOWED_SCHEMES.has(u.protocol);
	} catch {
		return false;
	}
}

/**
 * Hostnames that are never public, regardless of what DNS says.
 * @param {string} host  hostname as returned by `URL.hostname` (no brackets needed, but tolerated).
 */
export function isBlockedHostname(host) {
	const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
	if (h.length === 0) return true;
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h.endsWith(".local") || h.endsWith(".internal")) return true;
	if (h === "0.0.0.0") return true;
	return false;
}

/**
 * Strip IPv6 brackets and a zone id (`fe80::1%eth0`) so `isIP` / BlockList accept the literal.
 * @param {string} ip
 */
function normalizeIp(ip) {
	return String(ip ?? "").trim().replace(/^\[|\]$/gu, "").replace(/%.*$/u, "");
}

/**
 * Whether an IP literal is private / loopback / link-local / multicast / reserved.
 * Unparseable input counts as private (fail closed).
 * @param {string} ip
 */
export function isPrivateAddress(ip) {
	const addr = normalizeIp(ip);
	const family = isIP(addr);
	if (family === 4) return v4Blocks.check(addr, "ipv4");
	if (family === 6) {
		// IPv4-mapped (::ffff:a.b.c.d or ::ffff:XXXX:XXXX) → judge the embedded v4.
		const mapped = ipv4FromMapped(addr);
		if (mapped !== undefined) return isPrivateAddress(mapped);
		return v6Blocks.check(addr, "ipv6");
	}
	return true;
}

/**
 * Extract the dotted IPv4 from an IPv4-mapped IPv6 literal, or `undefined`.
 * @param {string} v6
 */
function ipv4FromMapped(v6) {
	const lower = v6.toLowerCase();
	let m = /^(?:0*:)*ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(lower);
	if (m) return m[1];
	m = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(lower);
	if (m) {
		const hi = Number.parseInt(m[1], 16);
		const lo = Number.parseInt(m[2], 16);
		return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	}
	return undefined;
}

/**
 * Default resolver: `dns.lookup(host, { all: true })` → list of address strings.
 * @param {string} host
 * @returns {Promise<string[]>}
 */
export async function defaultLookup(host) {
	const entries = await dns.lookup(host, { all: true, verbatim: true });
	return entries.map((e) => e.address);
}

/**
 * Parse `url`, validate scheme and hostname, resolve it and refuse if ANY
 * resolved address is non-public (unless `allowPrivate`).
 *
 * @param {string | URL} url
 * @param {{ allowPrivate?: boolean | ((hostname: string) => boolean), lookup?: (host: string) => Promise<string[]> }} [options]
 *   `allowPrivate` may be a predicate over the hostname (used by tests to permit
 *   a loopback fixture origin while still checking redirect targets).
 * @returns {Promise<{ url: URL, addresses: string[] }>}
 * @throws {BlockedUrlError}
 */
export async function assertSafeUrl(url, options = {}) {
	const { lookup = defaultLookup } = options;
	const raw = typeof url === "string" ? url : url.href;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new BlockedUrlError(raw, "not a valid absolute URL");
	}
	if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
		throw new BlockedUrlError(raw, `scheme "${parsed.protocol.replace(/:$/u, "")}" is not allowed (only http and https)`);
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) {
		throw new BlockedUrlError(raw, "URLs with embedded credentials are refused");
	}
	const host = parsed.hostname.replace(/^\[|\]$/gu, "");
	if (host.length === 0) throw new BlockedUrlError(raw, "missing hostname");
	const allowPrivate = typeof options.allowPrivate === "function" ? options.allowPrivate(host) === true : options.allowPrivate === true;

	if (!allowPrivate && isBlockedHostname(host)) {
		throw new BlockedUrlError(raw, `hostname "${host}" is reserved for local use`);
	}

	let addresses;
	if (isIP(host) !== 0) {
		addresses = [host];
	} else {
		try {
			addresses = await lookup(host);
		} catch (error) {
			throw new BlockedUrlError(raw, `DNS lookup for "${host}" failed (${error?.code ?? error?.message ?? String(error)})`);
		}
		if (!Array.isArray(addresses) || addresses.length === 0) {
			throw new BlockedUrlError(raw, `hostname "${host}" did not resolve to any address`);
		}
	}

	if (!allowPrivate) {
		const bad = addresses.find((a) => isPrivateAddress(a));
		if (bad !== undefined) {
			throw new BlockedUrlError(raw, `"${host}" resolves to ${bad}, a private or non-public address`);
		}
	}
	return { url: parsed, addresses };
}
