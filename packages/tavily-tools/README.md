# @tobedone4byme/dsh-web-tavily-tools

Tavily **Extract**, **Map** and **Research** for the [DeepSeek Harness](https://github.com/deepseek-ai). One cordis plugin, three registrations, one API key:

| Piece | Kind | Id / name | What it does |
| --- | --- | --- | --- |
| `lib/extract.js` | `web_fetch` **provider** | `tavily-extract` | Fetches a URL through Tavily `/extract` and returns clean Markdown. Handles JS-rendered pages, PDFs and many anti-bot sites. |
| `lib/map.js` | model-facing **tool** | `web_map` | Lists the URLs under a site root through Tavily `/map` (optionally filtered by natural-language instructions). No page bodies — a few dozen lines of context. |
| `lib/research.js` | model-facing **tool** | `web_research` | Runs an agentic multi-step research job through Tavily `/research` and returns one cited Markdown report. **Expensive and slow**; budgeted to 2 calls per session. |
| `lib/tavily-client.js` | shared client | – | Auth header, timeout, abort, status → message mapping (`WEB_PROVIDER_ERROR`, `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_ABORTED`). |
| `lib/client-api.js` | static catalogue | `TAVILY_ENDPOINTS` | Which Tavily endpoints exist and which DSH surface implements each (for docs / the provider-selector UI). |

Everything is plain ESM + JSDoc, no build step. The package depends only on `@tobedone4byme/dsh-web-shared` and `@deepseek-ai/schemastery`; the DSH host packages (`dsh-web`, `dsh-tools`, `dsh-settings`, …) are peers resolved from the DSH install.

---

## `tavily-extract` vs `readability-http`

Both implement the `dsh-web` fetch-provider contract (`{ url, statusCode, body: { kind, content }, truncated }`; non-2xx is a result, not a throw). Pick per profile:

| | `readability-http` (`@tobedone4byme/dsh-web-fetch-readability`) | `tavily-extract` (this package) |
| --- | --- | --- |
| How | Direct HTTP GET from your machine → Readability | Tavily fetches and renders, returns Markdown |
| JS-rendered SPAs | ✗ (sees the empty shell) | ✓ |
| PDFs | ✗ ("unsupported" note) | ✓ |
| Anti-bot / Cloudflare front doors | often ✗ | usually ✓ |
| Private / intranet URLs | blocked by the SSRF guard | impossible (Tavily can't reach them) |
| Privacy | URL stays on your machine | **URL is sent to Tavily** |
| Cost | free | **credits**: 1 per 5 URLs (`basic`), 2 per 5 (`advanced`) |
| Output | `kind: 'html'` → official tool converts to Markdown | `kind: 'text'` (already Markdown), capped at `maxOutputChars` with `[truncated: shown N of M chars]` |

Rule of thumb: keep `readability-http` as the default; switch to `tavily-extract` when the model keeps hitting empty SPA shells, PDFs or 403 walls — or when you are already paying Tavily for search and want one vendor.

A URL Tavily reports in `failed_results` comes back as `statusCode: 502` with `Tavily could not extract <url>: <error>` so the model can reason about it. Non-http(s) schemes are rejected up front with a `WEB_PROVIDER_ERROR`.

## `web_map` — the map → fetch pattern

`web_search` is for *"I don't know where the answer lives"*. When the model already knows the **site** (a docs portal, a product page tree) but not the **page**, repeated searches are the expensive way to browse. `web_map` is the cheap way:

```
web_map({ url: "https://docs.example.com", instructions: "only API reference pages", limit: 30 })
  → Mapped docs.example.com (30 URLs, truncated):
    - https://docs.example.com/api/auth
    - https://docs.example.com/api/users
    …
    Use web_fetch on the relevant URL(s).
web_fetch({ url: "https://docs.example.com/api/users" })
```

Parameters: `url` (required), `instructions` (optional natural-language filter), `limit` (default 30, max 100), `maxDepth` (1–3, default 1). Output `{ baseUrl, urls, truncated, notice? }`; URLs are deduped (hash / trailing slash / host case) and sorted.

Budget: `map.budgetPerSession` (default **5**) calls per session, keyed by `exec.agent.session.header.id` (`anonymous` for direct calls). Past the budget the tool returns `{ urls: [], notice }` and renders the notice instead of calling Tavily. `0` = unlimited.

System-prompt section registered: `tool:web_map` (order 112, right after `tool:web_search` / `tool:web_fetch`):

> Use web_map to list the pages of a documentation or product site before fetching; it costs almost no context. Prefer web_map + web_fetch over repeated web_search when you already know the site.

## `web_research` — delegated multi-source research

`web_search` answers *"find me a fact / a page"*. When the question needs **synthesis across many sources** (a comparison, a state-of-the-art overview, a multi-part question), the model would otherwise burn a dozen `web_search` + `web_fetch` rounds. `web_research` delegates that loop to Tavily `/research`, which searches, reads and writes one Markdown report with inline `[n]` citations.

It is the **expensive** tool of the family: several credits per run (`pro` more than `mini`) and 15–120 s of wall-clock time (a `mini` run measured ~15 s). Hence the defaults: `mini` model, 2 calls per session, 6 000-char answer cap.

```
web_research({ question: "Compare X and Y for Z in 2025; cite sources", depth: "mini" })
  → POST /research { input, model: "mini" }        → { request_id, status: "pending" }
  → GET  /research/{request_id} every 2 s          → pending → in_progress → completed
  → <report Markdown with [1] [2] …>

    Sources:
    1. Title A — https://a.example/…
    2. https://b.example/…
```

Parameters: `question` (required, self-contained), `depth` (`"mini"` default | `"pro"`). Output `{ answer, sources: [{ url, title? }], truncated, notice?, requestId }`; `answer` is capped at `research.maxAnswerChars` (then `truncated: true` plus a short notice), `sources` at `research.maxSources`. Polling stops at any status other than `pending` / `in_progress`; a non-`completed` terminal status (e.g. `failed`) or exceeding `research.timeoutMs` throws a `WEB_PROVIDER_ERROR`; an aborted tool call throws `WEB_ABORTED` and stops polling.

Budget: `research.budgetPerSession` (default **2**) calls per session, same keying as `web_map`. Past the budget the tool returns `{ answer: "", sources: [], notice, requestId: "" }` and renders the notice instead of calling Tavily. `0` = unlimited.

System-prompt section registered: `tool:web_research` (order 113, right after `tool:web_map`); the budget count is interpolated:

> Use web_research only for questions that need synthesis across many sources (comparisons, state-of-the-art overviews, multi-part questions). For one fact or one page use web_search or web_fetch instead. It is slow (15-120 s) and costs many credits, so it is budgeted: 2 calls per session. Prefer depth "mini"; use "pro" only when the user explicitly asks for exhaustive research.

## Configuration

Settings namespace `web-tavily-tools` (hot-reloaded from `~/.dsh/settings.yaml`); the same keys work in the `cordis.patch.yml` row.

| Key | Default | Notes |
| --- | --- | --- |
| `apiKey` | – | Secret; prefer `apiKeyEnv` |
| `apiKeyEnv` | `TAVILY_API_KEY` | Resolved via DSH credentials service → launch env → `process.env` |
| `baseURL` | `https://api.tavily.com` | |
| `timeoutMs` | `30000` | Per HTTP request; `0` disables |
| `extract.enabled` | `true` | Register the `tavily-extract` fetch provider (read at mount) |
| `extract.depth` | `basic` | `advanced` = 2× credits, better tables / complex layouts |
| `extract.maxOutputChars` | `20000` | Body cap with visible trailer |
| `map.enabled` | `true` | Register the `web_map` tool (read at mount) |
| `map.budgetPerSession` | `5` | `0` = unlimited |
| `map.defaultLimit` | `30` | URLs when the model gives no `limit` |
| `map.maxLimit` | `100` | Ceiling on `limit` |
| `map.maxDepth` | `3` | Ceiling on `maxDepth` (Tavily allows up to 5) |
| `map.timeoutMs` | `60000` | Cooperative tool-call timeout attached to `web_map` |
| `map.budgetNotice` | built-in text | Returned once the budget is exhausted |
| `research.enabled` | `true` | Register the `web_research` tool (read at mount) |
| `research.model` | `mini` | Default when the model gives no `depth`; `pro` = slower, more credits |
| `research.pollIntervalMs` | `2000` | Interval between `GET /research/{id}` polls |
| `research.timeoutMs` | `120000` | Give up polling after this long; the tool's cooperative timeout is this + 10 s |
| `research.maxAnswerChars` | `6000` | Report cap (`truncated: true` + notice past it) |
| `research.maxSources` | `10` | Cap on listed sources |
| `research.budgetPerSession` | `2` | `0` = unlimited |
| `research.budgetNotice` | built-in text | Returned once the budget is exhausted |

## Install & mount

```powershell
dsh plugin --profile web add ./packages/tavily-tools      # local checkout
# or, after publish:
dsh plugin --profile web add @tobedone4byme/dsh-web-tavily-tools
```

The shipped `cordis.patch.yml` inserts one row:

```yaml
- id: web-tavily-tools
  name: '@tobedone4byme/dsh-web-tavily-tools'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

Override it in `~/.dsh/profiles/web/cordis.patch.yml`, e.g.:

```yaml
- id: web-tavily-tools
  config:
    extract: { depth: advanced, maxOutputChars: 30000 }
    map: { budgetPerSession: 8 }
    research: { model: pro, budgetPerSession: 1 }
```

Credentials: `TAVILY_API_KEY` in the environment, or in `~/.dsh/settings.yaml`:

```yaml
web-tavily-tools:
  apiKey: tvly-xxxxxxxx
```

### Switching the fetch provider

Mounting this package only **registers** `tavily-extract`; `readability-http` stays active until you choose otherwise. Either:

- in `~/.dsh/profiles/web/cordis.patch.yml`
  ```yaml
  - id: web
    config:
      fetchProvider: tavily-extract
  ```
- or in the Web GUI → Settings → **Web providers** (`@tobedone4byme/dsh-web-provider-selector`) → Fetch → `tavily-extract`.

`web_fetch` itself must be enabled on the `tool-web` row / your agent preset (`fetch: true`) — see the repo README.

## Development

```powershell
node node_modules/vitest/vitest.mjs run packages/tavily-tools
```

Tests use local `http.createServer` fakes via `baseURL`; nothing touches the real Tavily API.

```
lib/
  index.js          plugin: Config, apply → provider + tools
  tavily-client.js  createTavilyClient({ resolveOptions }) → { extract, map, research, researchStatus, available }
  extract.js        TavilyExtractFetchProvider (id tavily-extract)
  map.js            applyWebMapTool / buildWebMapToolDefinition / formatMapOutput
  research.js       applyWebResearchTool / buildWebResearchToolDefinition / formatResearchOutput
  budget.js         SessionBudget
  client-api.js     TAVILY_ENDPOINTS catalogue
```
