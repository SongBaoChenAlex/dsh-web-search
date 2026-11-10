# @baoson/dsh-web-search-http

Generic HTTP web-search provider for the [DeepSeek Harness](https://github.com/deepseek-ai) web seam (`ctx.web`). One plugin, pluggable backends: **Tavily** (default), **Brave**, **Exa**, **Serper**, **Jina Search** and self-hosted **SearXNG**. Tavily is an LLM-native search API that returns a synthesized answer plus an extracted passage per result, so the model usually needs far fewer `web_fetch` follow-ups than with a classic snippet API.

The provider registers under the **backend name** (`tavily`, `brave`, …), so you select it with `searchProvider: <backend>`.

## What it does

```
web_search({ query })
  → ctx.web.search()
  → HttpSearchProvider (id = backend)
      resolve key (literal → credentials service → launch env)
      adapter.buildRequest()        POST https://api.tavily.com/search
      fetchWithTimeout()            redirect: 'error', 20 s default, caller abort honoured
      adapter.parseResponse()       answer → content, results[].content → snippet,
                                    published_date → publishedAt, dedupe by url, cap maxResults
  → { content?, sources[], truncated }
```

Errors are `WebError`s from `@deepseek-ai/dsh-web`:

| Situation | code |
| --- | --- |
| No key resolvable | `WEB_PROVIDER_CREDENTIAL_MISSING` |
| Non-2xx (401/403 → "check the credential", 429 rate limit, 432 plan quota), timeout, redirect, network failure, unparseable body | `WEB_PROVIDER_ERROR` |
| Caller aborted the search | `WEB_ABORTED` |

Each request is recorded on the initiating session as `web/http-search-request` (`{ endpoint, backend, query, maxResults }`), never including the key.

## Install

```powershell
dsh plugin --profile web add @baoson/dsh-web-search-http      # or ./packages/search-http from a checkout
```

The package's bundle patch (`cordis.patch.yml`) mounts one row:

```yaml
- id: web-search-tavily
  name: '@baoson/dsh-web-search-http'
  config:
    backend: tavily
    apiKeyEnv: TAVILY_API_KEY
```

### Select the provider (required)

The bundle patch **does not** change the `web` row. DSH's base pins `searchProvider: deepseek-official`; once two usable search providers exist and nothing is selected, the seam fails with **`WEB_PROVIDER_AMBIGUOUS`**. Pick this one in your profile patch (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: web
  config:
    searchProvider: tavily
```

Flip it back to `deepseek-official` at any time without touching this package. (`DSH_WEB_SEARCH_PROVIDER=tavily` in the launch environment works too.)

### Credentials

Either export `TAVILY_API_KEY` in the environment DSH is launched from / store it in the DSH credentials service, or put the key in `~/.dsh/settings.yaml` (hot-reloaded; section name is `web-search-<backend>`):

```yaml
web-search-tavily:
  apiKey: tvly-xxxxxxxx
```

Get a key at <https://app.tavily.com> (free tier: 1 000 credits/month; `basic` depth = 1 credit, `advanced` = 2).

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `backend` | `tavily` | Adapter to use; also becomes the provider id and the settings section name `web-search-<backend>`. Unknown ids fail at plugin load. |
| `apiKey` | – | Literal key (secret). Prefer `apiKeyEnv`. |
| `apiKeyEnv` | adapter default (`TAVILY_API_KEY`) | Credential reference / env var name. |
| `baseURL` | adapter default (`https://api.tavily.com`) | Override the endpoint (proxies, tests). |
| `timeoutMs` | `20000` | Per-request timeout; `0` disables. Keep it below `tool-web`'s `searchTimeoutMs` so the error is ours. |
| `maxResults` | `5` | Used when the tool does not pass `maxResults`; hard-capped at 20 (Tavily's ceiling). |
| `tavily.searchDepth` | `basic` | `basic` \| `advanced` (2× cost, better passages). |
| `tavily.includeAnswer` | `true` | Synthesized answer → result `content`. |
| `tavily.includeRawContent` | `false` | Full page text per result. Leave off — that is `web_fetch`'s job and it bloats the context. |
| `tavily.topic` | `general` | `general` \| `news`. |
| `tavily.includeDomains` | `[]` | Restrict results to these domains. |
| `tavily.excludeDomains` | `[]` | Drop these domains. |
| `brave.country` / `brave.searchLang` | `""` | Country / language codes (`US`, `zh-hans`). |
| `brave.safesearch` | `moderate` | `off` \| `moderate` \| `strict`. |
| `brave.freshness` | `""` | `pd` \| `pw` \| `pm` \| `py` or a date range. |
| `exa.type` | `auto` | `auto` \| `neural` \| `keyword` \| `fast`. |
| `exa.highlightsPerResult` / `exa.highlightSentences` | `2` / `3` | Extracted passage size per result. |
| `exa.includeDomains` / `exa.excludeDomains` | `[]` | Domain filters. |
| `serper.gl` / `serper.hl` | `""` | Google country (`us`) / UI language (`en`). `num` is sent as `min(maxResults, 10)` (free-plan cap). |
| `jina.site` | `""` | Restrict to one domain (sent as `X-Site`). Requests always carry `X-Respond-With: no-content` so results are summaries, not full pages. |
| `searxng.language` | `""` | Language code (`en`, `zh-CN`); empty = instance default. |
| `searxng.categories` / `searxng.engines` | `""` | Comma-separated SearXNG categories / engine names. |
| `searxng.safesearch` | `1` | `0` \| `1` \| `2`. |
| `searxng.timeRange` | `""` | `day` \| `month` \| `year`. |

### Backends

| `backend` | Class | Default `baseURL` | Default `apiKeyEnv` | Free tier |
| --- | --- | --- | --- | --- |
| `tavily` | LLM-native | `https://api.tavily.com` | `TAVILY_API_KEY` | 1,000 credits/month |
| `brave` | search engine | `https://api.search.brave.com/res/v1` | `BRAVE_SEARCH_API_KEY` | 2,000 queries/month |
| `exa` | LLM-native (neural) | `https://api.exa.ai` | `EXA_API_KEY` | $10 starter credit |
| `serper` | search engine (Google SERP) | `https://google.serper.dev` | `SERPER_API_KEY` | 2,500 queries one-time |
| `jina` | LLM-native (reader) | `https://s.jina.ai` | `JINA_API_KEY` | 10M tokens |
| `searxng` | self-hosted meta search | `http://127.0.0.1:8080` | `SEARXNG_API_KEY` (optional) | free, self-hosted |

Example `cordis.patch.yml` rows (one row per backend you want; each registers a provider under its backend id, then pick one with `searchProvider:` in the `web` row):

```yaml
- id: web-search-serper
  name: '@baoson/dsh-web-search-http'
  config:
    backend: serper
    apiKeyEnv: SERPER_API_KEY

- id: web-search-jina
  name: '@baoson/dsh-web-search-http'
  config:
    backend: jina
    apiKeyEnv: JINA_API_KEY

- id: web-search-searxng
  name: '@baoson/dsh-web-search-http'
  config:
    backend: searxng
    baseURL: http://127.0.0.1:8080   # your instance; required unless it really runs on localhost:8080
```

**SearXNG needs a `baseURL`.** There is no public endpoint: point `baseURL` at your own instance (the default `http://127.0.0.1:8080` only matches the docker-compose quick start). The instance must allow the JSON format (`search: formats: [html, json]` in its `settings.yml`), otherwise it answers 403. No API key is required — the provider is `available()` as soon as `baseURL` parses; `SEARXNG_API_KEY` is only sent as `Authorization: Bearer …` if you put the instance behind an authenticating proxy.

Everything can be set in the cordis row's `config:` or in the settings section; the settings section wins and is hot-reloaded.

## Adding a backend

1. Create `lib/adapters/<id>.js` exporting an object matching the `SearchAdapter` typedef in `lib/adapter.js`:
   `id`, `defaultBaseURL`, `defaultApiKeyEnv`, `buildRequest(request, options) → { url, init }`, `parseResponse(json, request, { maxResults }) → WebSearchResult`, `describeError(status, json, { apiKeyEnv }) → string`.
2. Register it in the `adapters` object in `lib/adapter.js`.
3. If it needs its own options, add a `<id>:` sub-schema to `Config` in `lib/index.js`; it is passed to the adapter as `options.backend`.
4. Key-less backends set `requiresKey: false` on the adapter; `available()` then only checks `baseURL`, and `buildRequest` receives an empty `apiKey` when none is configured.

Credential resolution, timeout, abort, redirect policy, `WebError` mapping and settings hot-reload are already shared — an adapter is pure request/response shaping.

## Development

```powershell
# from the monorepo root
node node_modules/vitest/vitest.mjs run packages/search-http
```

Tests never hit the real network: a local `http.createServer` plays Tavily through `baseURL`.

Plain ESM JavaScript + JSDoc, no build step. Works with the pairing `@baoson/dsh-web-search-governor`, whose `providerOverrides.tavily.snippetMaxChars: 800` keeps Tavily's richer passages while still capping them.
