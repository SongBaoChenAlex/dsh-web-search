/**
 * Bytes → string with charset detection: Content-Type header → BOM →
 * `<meta charset>` / `http-equiv` sniff (first 2 KB) → UTF-8.
 * @module @tobedone4byme/dsh-web-fetch-readability/decode
 */

const SNIFF_BYTES = 2048;

/** Aliases TextDecoder does not know (or that pages commonly misspell). */
const ALIASES = new Map([
	["gb2312", "gbk"],
	["gb_2312", "gbk"],
	["gb_2312-80", "gbk"],
	["x-gbk", "gbk"],
	["cp936", "gbk"],
	["ms936", "gbk"],
	["big-5", "big5"],
	["cp950", "big5"],
	["shift-jis", "shift_jis"],
	["sjis", "shift_jis"],
	["ms932", "shift_jis"],
	["windows-31j", "shift_jis"],
	["euckr", "euc-kr"],
	["cp949", "euc-kr"],
	["ks_c_5601-1987", "euc-kr"],
	["latin1", "windows-1252"],
	["latin-1", "windows-1252"],
	["iso-8859-1", "windows-1252"], // WHATWG maps 8859-1 to 1252 anyway
	["iso8859-1", "windows-1252"],
	["ascii", "windows-1252"],
	["us-ascii", "windows-1252"],
	["utf8", "utf-8"],
	["unicode", "utf-16le"],
]);

/**
 * @param {string | undefined | null} label
 * @returns {string | undefined} normalized label or undefined when empty.
 */
export function normalizeCharset(label) {
	if (typeof label !== "string") return undefined;
	const l = label.trim().toLowerCase().replace(/^["']|["']$/gu, "");
	if (l.length === 0) return undefined;
	return ALIASES.get(l) ?? l;
}

/**
 * Pull `charset=` out of a Content-Type header.
 * @param {string | undefined | null} contentType
 */
export function charsetFromContentType(contentType) {
	if (typeof contentType !== "string") return undefined;
	const m = /;\s*charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/iu.exec(contentType);
	return m ? normalizeCharset(m[1]) : undefined;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ charset: string, bomLength: number } | undefined}
 */
export function charsetFromBom(bytes) {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { charset: "utf-8", bomLength: 3 };
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: "utf-16be", bomLength: 2 };
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: "utf-16le", bomLength: 2 };
	return undefined;
}

/**
 * Sniff `<meta charset>` / `<meta http-equiv=content-type>` (or an XML prolog)
 * in the first {@link SNIFF_BYTES} bytes, decoded as latin1 (ASCII-safe).
 * @param {Uint8Array} bytes
 */
export function charsetFromMeta(bytes) {
	const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, SNIFF_BYTES));
	let m = /<meta[^>]*?charset\s*=\s*["']?\s*([a-z0-9_\-:.]+)/iu.exec(head);
	if (m) return normalizeCharset(m[1]);
	m = /<\?xml[^>]*encoding\s*=\s*["']([a-z0-9_\-:.]+)["']/iu.exec(head);
	if (m) return normalizeCharset(m[1]);
	return undefined;
}

/**
 * @param {string} charset
 * @returns {TextDecoder | undefined} undefined when this runtime lacks the encoding.
 */
function decoderFor(charset) {
	try {
		return new TextDecoder(charset, { fatal: false, ignoreBOM: false });
	} catch {
		return undefined; // RangeError: unknown / unsupported encoding
	}
}

/**
 * Decode a body to a string.
 * @param {Uint8Array} bytes
 * @param {string | undefined | null} [contentTypeHeader]
 * @param {{ sniffMeta?: boolean }} [options]  `sniffMeta` defaults to true.
 * @returns {string}
 */
export function decodeBody(bytes, contentTypeHeader, options = {}) {
	const sniffMeta = options.sniffMeta ?? true;
	const bom = charsetFromBom(bytes);
	const charset = bom?.charset
		?? charsetFromContentType(contentTypeHeader)
		?? (sniffMeta ? charsetFromMeta(bytes) : undefined)
		?? "utf-8";
	const decoder = decoderFor(charset) ?? new TextDecoder("utf-8");
	const text = decoder.decode(bytes);
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Which charset `decodeBody` would pick (exposed for tests / debugging). */
export function detectCharset(bytes, contentTypeHeader) {
	return charsetFromBom(bytes)?.charset ?? charsetFromContentType(contentTypeHeader) ?? charsetFromMeta(bytes) ?? "utf-8";
}
