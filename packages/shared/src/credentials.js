/**
 * API-key resolution mirroring `@deepseek-ai/dsh-web-search-deepseek`:
 * literal `apiKey` → credentials service → launch environment variable.
 *
 * Host packages are resolved via importHost (plugins live outside the DSH
 * installation); when unavailable (unit tests) resolution falls back to a
 * literal key or `process.env`.
 * @module @tobedone4byme/dsh-web-shared/credentials
 */

import { importHost } from "./host.js";

let hostModules;
async function loadHost(ctx) {
	if (hostModules !== undefined) return hostModules;
	const [creds, launch] = await Promise.all([
		importHost(ctx, "@deepseek-ai/dsh-credentials"),
		importHost(ctx, "@deepseek-ai/dsh-launch-environment"),
	]);
	hostModules = creds && launch ? { credentialRef: creds.credentialRef, launchEnvironmentOf: launch.launchEnvironmentOf } : null;
	return hostModules;
}
/**
 * Build a resolver bound to a cordis context.
 * @param {any} ctx
 * @param {{ apiKey?: string, apiKeyEnv: string }} config
 * @returns {{ literal: string | undefined, envName: string, canResolve: () => boolean, resolve: () => Promise<string | undefined> }}
 */
export function apiKeyResolver(ctx, config) {
	const envName = config.apiKeyEnv;
	const literal = typeof config.apiKey === "string" && config.apiKey.length > 0 ? config.apiKey : undefined;
	/**
	 * Last real resolution outcome with its timestamp. Keys can be added or removed at
	 * runtime (settings page), so a negative answer only counts for a short while.
	 */
	let known;
	let knownAt = 0;
	const KNOWN_TTL_MS = 30_000;
	const remember = (value) => { known = value !== undefined; knownAt = Date.now(); };
	const knownFresh = () => known !== undefined && Date.now() - knownAt < KNOWN_TTL_MS;
	const credentialsService = () => {
		try {
			return ctx?.get?.("credentials");
		} catch {
			return undefined;
		}
	};
	void loadHost(ctx).then(async (host) => {
		// Warm the answer in the background so `available()` is right shortly after boot.
		if (literal !== undefined || host === null) return;
		try {
			remember(await resolveViaHost(host));
		} catch {
			// leave unknown
		}
	});
	async function resolveViaHost(host) {
		const ref = host.credentialRef(envName);
		const credentials = credentialsService();
		if (credentials !== undefined) {
			const value = (await credentials.resolve(ref))?.value;
			if (value !== undefined && value.length > 0) return value;
		}
		try {
			const ambient = host.launchEnvironmentOf(ctx).get(ref);
			if (ambient !== undefined && ambient.value.length > 0) return ambient.value;
		} catch {
			// no launch environment on this ctx — fall through to process.env
		}
		const env = process.env[envName];
		return typeof env === "string" && env.length > 0 ? env : undefined;
	}
	return {
		literal,
		envName,
		/**
		 * Cheap, synchronous — suitable for a provider's `available()`.
		 * Exact once a resolution has run (the answer expires after 30 s so a key
		 * added via the settings page is picked up); otherwise optimistic when a
		 * credentials service exists (the key may be in the store).
		 */
		canResolve: () => literal !== undefined
			|| (knownFresh() ? known : credentialsService() !== undefined)
			|| (typeof process.env[envName] === "string" && process.env[envName].length > 0),
		async resolve() {
			if (literal !== undefined) return literal;
			const host = await loadHost(ctx);
			const value = host ? await resolveViaHost(host) : (() => {
				const env = process.env[envName];
				return typeof env === "string" && env.length > 0 ? env : undefined;
			})();
			remember(value);
			return value;
		},
	};
}
