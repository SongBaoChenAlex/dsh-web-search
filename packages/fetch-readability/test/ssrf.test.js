import { describe, it, expect } from "vitest";
import { assertSafeUrl, BlockedUrlError, isAllowedScheme, isBlockedHostname, isPrivateAddress } from "../lib/ssrf.js";

describe("isAllowedScheme", () => {
	it.each([
		["http://example.com", true],
		["https://example.com/a?b", true],
		["ftp://example.com", false],
		["file:///etc/passwd", false],
		["javascript:alert(1)", false],
		["data:text/html,hi", false],
		["not a url", false],
	])("%s → %s", (url, expected) => {
		expect(isAllowedScheme(url)).toBe(expected);
	});
});

describe("isBlockedHostname", () => {
	it.each([
		["localhost", true],
		["LOCALHOST", true],
		["foo.localhost", true],
		["printer.local", true],
		["db.internal", true],
		["0.0.0.0", true],
		["", true],
		["example.com", false],
		["localhost.example.com", false],
		["internal.example.com", false],
		["mylocal.com", false],
	])("%s → %s", (host, expected) => {
		expect(isBlockedHostname(host)).toBe(expected);
	});
});

describe("isPrivateAddress", () => {
	it.each([
		// IPv4 private / special
		["0.0.0.0", true], ["0.1.2.3", true],
		["10.0.0.1", true], ["10.255.255.255", true],
		["100.64.0.1", true], ["100.127.255.254", true], ["100.128.0.1", false],
		["127.0.0.1", true], ["127.255.0.1", true],
		["169.254.169.254", true],
		["172.16.0.1", true], ["172.31.255.255", true], ["172.32.0.1", false], ["172.15.0.1", false],
		["192.0.0.1", true], ["192.0.1.1", false],
		["192.168.1.1", true],
		["198.18.0.1", true], ["198.19.255.255", true], ["198.20.0.1", false],
		["224.0.0.1", true], ["239.255.255.255", true],
		["240.0.0.1", true], ["255.255.255.255", true],
		// IPv4 public
		["8.8.8.8", false], ["93.184.216.34", false], ["1.1.1.1", false],
		// IPv6
		["::", true], ["::1", true],
		["fc00::1", true], ["fd12:3456::1", true], ["fe80::1", true], ["febf::1", true], ["fec0::1", false],
		["ff02::1", true],
		["::ffff:127.0.0.1", true], ["::ffff:10.1.2.3", true], ["::ffff:8.8.8.8", false],
		["::ffff:7f00:1", true], ["::ffff:0808:0808", false],
		["2001:4860:4860::8888", false], ["2606:4700::1111", false],
		["[::1]", true], ["fe80::1%eth0", true],
		// garbage fails closed
		["not-an-ip", true], ["", true],
	])("%s → %s", (ip, expected) => {
		expect(isPrivateAddress(ip)).toBe(expected);
	});
});

describe("assertSafeUrl", () => {
	const publicLookup = async () => ["93.184.216.34"];

	it("accepts a public host and returns the parsed URL + addresses", async () => {
		const r = await assertSafeUrl("https://example.com/path?q=1", { lookup: publicLookup });
		expect(r.url.hostname).toBe("example.com");
		expect(r.addresses).toEqual(["93.184.216.34"]);
	});

	it("rejects bad schemes without resolving", async () => {
		let called = false;
		await expect(assertSafeUrl("ftp://example.com", { lookup: async () => { called = true; return ["1.1.1.1"]; } })).rejects.toBeInstanceOf(BlockedUrlError);
		expect(called).toBe(false);
	});

	it("rejects invalid URLs", async () => {
		await expect(assertSafeUrl("::nope::", { lookup: publicLookup })).rejects.toThrow(/not a valid absolute URL/u);
	});

	it("rejects embedded credentials", async () => {
		await expect(assertSafeUrl("https://user:pw@example.com", { lookup: publicLookup })).rejects.toThrow(/credentials/u);
	});

	it("rejects blocked hostnames", async () => {
		await expect(assertSafeUrl("http://localhost:3080/", { lookup: publicLookup })).rejects.toThrow(/reserved for local use/u);
		await expect(assertSafeUrl("http://foo.internal/", { lookup: publicLookup })).rejects.toThrow(BlockedUrlError);
	});

	it("rejects literal private IPs", async () => {
		await expect(assertSafeUrl("http://127.0.0.1:3080/", { lookup: publicLookup })).rejects.toThrow(/private or non-public/u);
		await expect(assertSafeUrl("http://[::1]/", { lookup: publicLookup })).rejects.toThrow(BlockedUrlError);
		await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data", { lookup: publicLookup })).rejects.toThrow(BlockedUrlError);
	});

	it("rejects when ANY resolved address is private (DNS rebinding shape)", async () => {
		const lookup = async () => ["93.184.216.34", "10.0.0.5"];
		await expect(assertSafeUrl("http://evil.test/", { lookup })).rejects.toThrow(/10\.0\.0\.5/u);
	});

	it("rejects DNS failures and empty answers", async () => {
		await expect(assertSafeUrl("http://nx.test/", { lookup: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } })).rejects.toThrow(/ENOTFOUND/u);
		await expect(assertSafeUrl("http://nx.test/", { lookup: async () => [] })).rejects.toThrow(/did not resolve/u);
	});

	it("allowPrivate bypasses hostname and address checks", async () => {
		const r = await assertSafeUrl("http://127.0.0.1:1234/", { allowPrivate: true, lookup: publicLookup });
		expect(r.addresses).toEqual(["127.0.0.1"]);
		const r2 = await assertSafeUrl("http://localhost/", { allowPrivate: true, lookup: async () => ["::1"] });
		expect(r2.url.hostname).toBe("localhost");
	});
});
