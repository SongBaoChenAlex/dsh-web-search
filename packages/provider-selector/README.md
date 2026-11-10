# @tobedone4byme/dsh-web-provider-selector

A **"Web providers"** section in the DeepSeek Harness Web GUI settings page.

![Web providers settings section](./docs/screenshot-placeholder.png)
*(screenshot placeholder — Settings → Web providers)*

It lets you:

1. **See every web provider in two compact tables** — search (`web_search`) and fetch (`web_fetch`). One row per id: `● Label  <id>  [kind]  …  status  action  ?`. Registered providers show a green dot; rows that need attention (key missing / unavailable / not mounted) are greyed.
2. **Switch the active provider live.** Clicking *Use* assigns `ctx.web.searchProviderId` / `fetchProviderId` on the running host (the seam resolves providers at call time, so the next tool call already uses it — no restart) and persists the choice.
3. **Add keys** inline (*Add key* expands an editor under the row). Keys go through DSH's credentials store (`$DSH_HOME/.credentials.yaml`, the same place the Models page writes `DEEPSEEK_API_KEY`), never through `settings.yaml`. Docs / key links, free tier, the key env and *Change / Remove key* live in the row's `?` menu.
4. **Catalog backends** from `@tobedone4byme/dsh-web-search-http` (Tavily, Brave, Exa) that are not yet mounted appear as dimmed *Not mounted* rows in the same search table — never as a duplicate of a registered provider. After a key is saved the row shows the `cordis.patch.yml` snippet to add, with a copy button.

## Install

```powershell
pnpm --filter @tobedone4byme/dsh-web-provider-selector build:client   # produces lib/client.js
dsh plugin --profile web add ./packages/provider-selector       # mounts the row from cordis.patch.yml
```

Then refresh the Web GUI. The package is a *dual-face* plugin: the host half (`lib/index.js`) is mounted as cordis row `web-provider-selector`; because `package.json` declares `dsh.client`, `@deepseek-ai/dsh-client-modules` serves `lib/client.js` as `/plugins/<id>/client.js`.

## How it works

```
Web GUI (lib/client.js)                      Host (lib/index.js + lib/service.js)
───────────────────────                      ─────────────────────────────────────
ctx.remote.$mount(TYPERT_REMOTE)   ───────►  WebProviderSelector extends TypertRemoteService
  installs remote.webProviders                 service key  webProviderSelector
                                               namespace    webProviders
remote.webProviders.list()         ───────►  iterate ctx.web.searchProviders / fetchProviders,
                                             provider.available(), ctx.credentials.describe(ref)
remote.webProviders.select(kind,id)───────►  ctx.web.<kind>ProviderId = id   (live)
                                             settings scope.update({ searchProvider: id })  (persist)
remote.webProviders.setKey(ref,v)  ───────►  ctx.credentials.set(ref, v)
remote.webProviders.unsetKey(ref)  ───────►  ctx.credentials.unset(ref)
```

### Selection persistence

- Namespace `web-provider-selector` in `~/.dsh/settings.yaml`, schema `{ searchProvider?: string, fetchProvider?: string }`.
- Registered via `ctx.settings.register(ns, Config, { base: rowConfig })` (the `installSettingsSection` pattern, kept open so the remote can **write**): `select()` calls `SettingsScope.update(patch)` → `SettingsProvider.update()` → merged into the user layer and persisted.
- On boot the row config is applied, then the resolved settings value; `scope.watch()` re-applies on every committed change (e.g. editing `settings.yaml` by hand).
- The `web` row's own `searchProvider`/`fetchProvider` remain the *initial* value; this plugin overrides the runtime field afterwards. If you prefer the composition to win, leave the GUI selection untouched.

### Credentials

Host-side: `ctx.get("credentials")` (`@deepseek-ai/dsh-credentials` `CredentialProvider`): `describe(ref)`, `set(ref, value)`, `unset(ref)`. The browser never sees key values except the one it is submitting. A ref must be an environment-variable name (`TAVILY_API_KEY`). `set` is rejected by the provider while a read-only layer (the live environment) shadows the ref — the error surfaces inline in the UI.

### Remote wiring

- **Host**: no generated typert manifest. The API gateway (`@deepseek-ai/dsh-api-gateway`) discovers the service through its SRC fallback: `typertRemote` binding + `@Remote` markers (applied manually via the standard decorator protocol in `defineWebProviderSelector`) + parameter names parsed from `Function.prototype.toString`. Therefore remote methods use plain identifier parameters (`select(kind, id)`), verified by a test.
- **Client**: `lib/typert.remote-client.js` is a hand-written `TYPERT_REMOTE` contribution with lightweight strict codecs (`{ mode: 'strict', typeSymbol, schema: { parse } }`), mounted by the plugin itself. `remote.webProviders` only exists *after* that mount, so it is **not** in `inject`; the slot registration is scoped with `ctx.inject(["remote.webProviders"], …)`.

## Development

```powershell
pnpm --filter @tobedone4byme/dsh-web-provider-selector build:client
node node_modules/vitest/vitest.mjs run packages/provider-selector
node packages/provider-selector/scripts/smoke-host.mjs        # real cordis + gateway, fake ctx.web
node packages/provider-selector/scripts/smoke-client-dom.mjs  # renders the bundle with linkedom
```

```
lib/
  index.js                 cordis plugin: settings wiring + instantiates the service
  service.js               ProviderSelectorCore (testable) + defineWebProviderSelector(protocol)
  typert.remote-client.js  TYPERT_REMOTE client contribution
  client.js                built browser bundle (esbuild, see scripts/build-client.mjs)
src/client/
  index.jsx                apply/inject, styles, slot registration
  WebProvidersSection.jsx  UI
  locales.js               zh / en dictionaries
```

## Limitations

- **Adding a provider does not mount a `search-http` row.** Writing `cordis.patch.yml` is out of scope; the *Not mounted* row shows the exact composition snippet to add (with a copy button). Keys can be stored beforehand.
- The gateway SRC fallback returns results as `src-json`; there is no strict host-side schema for this namespace (the client codecs are structural). If DSH later forbids SRC fallback for user plugins, a generated `./typert` manifest (zod) would be needed.
- `available()` of credential-backed providers is optimistic when a credentials service exists; the UI folds the real `describe()` state in (`usable`), so a provider with no key shows greyed out even if `available()` says true.
- No reactive push: the page refreshes after every mutation and on *Refresh*; it does not subscribe to `credentials/updated` / `settings/document-updated` events.
