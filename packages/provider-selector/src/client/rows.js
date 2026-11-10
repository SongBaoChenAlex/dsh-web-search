/**
 * Pure helpers that turn the host `list()` payload into the unified rows the
 * settings page renders — one row per provider id, registered providers
 * merged with their catalog metadata, unregistered catalog entries appended
 * as dimmed "not mounted" rows. No React, no DOM: unit-tested directly.
 */

/**
 * @typedef {"active"|"usable"|"keyMissing"|"unavailable"|"catalog"} RowState
 *
 * @typedef {object} Row
 * @property {string} id
 * @property {"search"|"fetch"} kind
 * @property {string} label
 * @property {string} providerKind
 * @property {string} [description]
 * @property {boolean} registered
 * @property {boolean} active
 * @property {RowState} state
 * @property {"on"|"off"} dot
 * @property {"use"|"addKey"|null} action  Exactly one primary action (or none).
 * @property {string} [keyEnv]
 * @property {boolean} [keyConfigured]
 * @property {string} [keySource]
 * @property {boolean} [requiresKey]  false for key-less backends (self-hosted SearXNG).
 * @property {string} [docsUrl]
 * @property {string} [keyUrl]
 * @property {string} [freeTier]
 */

/**
 * Decide the row state. Precedence: active > usable > key missing > unavailable;
 * unregistered (catalog-only) entries are always `catalog`.
 * @param {{ registered?: boolean, usable?: boolean, available?: boolean, keyEnv?: string, keyConfigured?: boolean }} row
 * @param {boolean} active
 * @returns {RowState}
 */
export function rowState(row, active) {
	if (row.registered !== true) return "catalog";
	if (active) return "active";
	if (row.usable !== false && row.available === true) return "usable";
	if (row.keyEnv !== undefined && row.keyConfigured === false) return "keyMissing";
	return "unavailable";
}

/**
 * The single primary action for a state.
 * @param {RowState} state
 * @param {{ keyEnv?: string }} row
 * @returns {"use"|"addKey"|null}
 */
export function rowAction(state, row) {
	switch (state) {
		case "usable": return "use";
		case "keyMissing": return row.keyEnv === undefined ? null : "addKey";
		case "catalog": return row.keyEnv === undefined ? null : "addKey";
		default: return null;
	}
}

/**
 * Merge one registered provider with its catalog entry (if any). Provider
 * fields win; the catalog only contributes what the provider lacks.
 * @param {any} provider
 * @param {any} [entry]
 * @param {boolean} active
 * @returns {Row}
 */
function fromProvider(provider, entry, active) {
	const base = {
		id: provider.id,
		kind: provider.kind,
		label: provider.label ?? entry?.label ?? provider.id,
		providerKind: provider.providerKind ?? entry?.kind ?? "unknown",
		description: provider.description ?? entry?.description,
		registered: true,
		available: provider.available,
		usable: provider.usable,
		keyEnv: provider.keyEnv ?? entry?.keyEnv,
		keyConfigured: provider.keyConfigured ?? entry?.keyConfigured,
		keySource: provider.keySource ?? entry?.keySource,
		requiresKey: entry?.requiresKey,
		docsUrl: entry?.docsUrl,
		keyUrl: entry?.keyUrl,
		freeTier: entry?.freeTier,
	};
	return finish(base, active);
}

/**
 * A catalog entry with no registered provider behind it.
 * @param {any} entry
 * @returns {Row}
 */
function fromCatalog(entry) {
	return finish({
		id: entry.id,
		kind: "search",
		label: entry.label ?? entry.id,
		providerKind: entry.kind ?? "engine",
		description: entry.description,
		registered: false,
		keyEnv: entry.keyEnv,
		keyConfigured: entry.keyConfigured,
		keySource: entry.keySource,
		requiresKey: entry.requiresKey,
		docsUrl: entry.docsUrl,
		keyUrl: entry.keyUrl,
		freeTier: entry.freeTier,
	}, false);
}

/** @returns {Row} */
function finish(base, active) {
	const state = rowState(base, active);
	const out = {
		...base,
		active,
		state,
		dot: state === "active" || state === "usable" ? "on" : "off",
		action: rowAction(state, base),
	};
	delete out.available;
	delete out.usable;
	for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
	return out;
}

/**
 * Build the two tables. Each id appears exactly once per kind; a registered
 * provider always wins over its catalog twin (metadata is merged into it).
 * Catalog entries only describe search backends, so they join the search table.
 * @param {{ search?: any[], fetch?: any[], active?: { search?: string, fetch?: string }, catalog?: any[] }} listing
 * @returns {{ search: Row[], fetch: Row[] }}
 */
export function mergeRows(listing) {
	const catalog = Array.isArray(listing?.catalog) ? listing.catalog : [];
	const byId = new Map(catalog.map((entry) => [entry.id, entry]));
	const active = listing?.active ?? {};

	const table = (kind, providers, withCatalog) => {
		const rows = [];
		const seen = new Set();
		for (const provider of Array.isArray(providers) ? providers : []) {
			if (seen.has(provider.id)) continue;
			seen.add(provider.id);
			rows.push(fromProvider({ kind, ...provider }, byId.get(provider.id), provider.id === active[kind]));
		}
		if (withCatalog) {
			for (const entry of catalog) {
				if (seen.has(entry.id)) continue;
				seen.add(entry.id);
				rows.push(fromCatalog(entry));
			}
		}
		return rows;
	};

	return {
		search: table("search", listing?.search, true),
		fetch: table("fetch", listing?.fetch, false),
	};
}

/**
 * The composition row a user adds to `~/.dsh/profiles/web/cordis.patch.yml`
 * to mount a catalog backend.
 * @param {{ id: string, keyEnv?: string }} row
 * @returns {string}
 */
export function mountSnippet(row) {
	const keyEnv = row.keyEnv ?? `${row.id.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_API_KEY`;
	return [
		`- id: web-search-${row.id}`,
		`  name: "@baoson/dsh-web-search-http"`,
		`  config: { backend: ${row.id}, apiKeyEnv: ${keyEnv} }`,
	].join("\n");
}
