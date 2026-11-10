/**
 * Hand-written client Remote contribution for the `webProviders` namespace.
 *
 * Mirrors the shape `@deepseek-ai/dsh-typert-generator` emits
 * (`TYPERT_REMOTE = { package, descriptors[] }`), but with lightweight
 * structural codecs instead of zod so the browser bundle stays small. See
 * `codec()` below for the two contracts a codec must satisfy. The host side has
 * no generated manifest and is served by the API gateway's SRC fallback
 * (`@Remote` markers + parameter names parsed from the method signature), so
 * parameter `wire` names below MUST equal the host method parameter names in
 * `lib/service.js`.
 *
 * @module @baoson/dsh-web-provider-selector/remote
 */

const PACKAGE = "@baoson/dsh-web-provider-selector";
const NAMESPACE = "webProviders";

/**
 * Minimal codec: type-check at the boundary, pass the value through.
 *
 * Satisfies both Remote codec contracts seen in the field:
 * - dsh 0.1.x gateway: `{ mode: 'strict', typeSymbol, schema: { parse() } }`.
 * - dsh >= 0.2 typert registry: additionally requires a `create()` factory
 *   (generated contributions return a zod schema; the gateway itself only
 *   reads `mode` and the optional `result.decode`). We return a tiny
 *   schema-like object so no validation library ships in the bundle.
 */
function codec(symbol, check) {
	const parse = (value) => {
		const problem = check(value);
		if (problem !== undefined) throw new TypeError(`${symbol}: ${problem}`);
		return value;
	};
	/** Standard-Schema-flavoured stand-in for a zod schema. */
	const schema = {
		parse,
		safeParse: (value) => {
			try {
				return { success: true, data: parse(value) };
			} catch (error) {
				return { success: false, error };
			}
		},
		optional: () => schema,
		nonoptional: () => schema,
		"~standard": {
			version: 1,
			vendor: "@baoson/dsh-web-provider-selector",
			validate: (value) => {
				const problem = check(value);
				return problem === undefined ? { value } : { issues: [{ message: `${symbol}: ${problem}` }] };
			},
		},
	};
	return {
		mode: "strict",
		typeSymbol: `${PACKAGE}/types#${symbol}`,
		schema,
		create: () => schema,
		decode: parse,
		jsonSchemaError: `${PACKAGE}: hand-written codec ${symbol} has no JSON Schema`,
	};
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyString = (v) => (typeof v === "string" && v.length > 0 ? undefined : "expected a non-empty string");
const oneOfKind = (v) => (v === "search" || v === "fetch" ? undefined : 'expected "search" or "fetch"');
const providerArray = (v) => (Array.isArray(v) && v.every((p) => isObject(p) && typeof p.id === "string") ? undefined : "expected Provider[]");

const KIND = codec("ProviderKind", oneOfKind);
const ID = codec("ProviderId", nonEmptyString);
const REF = codec("CredentialRef", nonEmptyString);
const SECRET = codec("CredentialValue", nonEmptyString);

const LIST_RESULT = codec("ProviderListing", (v) => {
	if (!isObject(v)) return "expected an object";
	if (providerArray(v.search) !== undefined) return "search: expected Provider[]";
	if (providerArray(v.fetch) !== undefined) return "fetch: expected Provider[]";
	if (!isObject(v.active)) return "active: expected an object";
	if (!Array.isArray(v.catalog)) return "catalog: expected an array";
	return undefined;
});
const SELECT_RESULT = codec("SelectResult", (v) => (isObject(v) && v.ok === true && isObject(v.active) ? undefined : "expected { ok: true, active }"));
const KEY_RESULT = codec("KeyResult", (v) => (isObject(v) && v.ok === true && typeof v.ref === "string" ? undefined : "expected { ok: true, ref }"));

function descriptor(method, parameters, result) {
	return {
		id: `${PACKAGE}#${NAMESPACE}/${method}`,
		service: "webProviderSelector",
		namespace: NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: parameters.map(([name, c]) => ({ name, wire: name, source: "json", codec: c })),
		result,
	};
}

export const TYPERT_REMOTE = {
	package: PACKAGE,
	descriptors: [
		descriptor("list", [], LIST_RESULT),
		descriptor("select", [["kind", KIND], ["id", ID]], SELECT_RESULT),
		descriptor("setKey", [["ref", REF], ["value", SECRET]], KEY_RESULT),
		descriptor("unsetKey", [["ref", REF]], KEY_RESULT),
	],
};

export default TYPERT_REMOTE;
