# @baoson/dsh-web-search-demo-command

A DeepSeek Harness slash command for presentations and debugging:

```
/web-search-demo                 # uses defaultQuery (蓝色大肥鱼)
/web-search-demo 你的查询词
```

It performs **one real search through `ctx.web.search()`** — the same seam the model's `web_search` tool uses, with the same provider selection, credential resolution and `web/http-search-request` session event — and renders the whole pipeline in the command card:

| Step | Shows | Source it points at |
| --- | --- | --- |
| 0 | ASCII call chain | package map |
| 1 | registered / usable / configured / **selected** provider and the rule that chose it | `web` row, `dsh-web`, `HttpSearchProvider.available()` |
| 2 | exact wire request (key redacted) + key-resolution order | `credentials.js`, `tavily.js buildRequest`, `http.js fetchWithTimeout` |
| 3 | session events before/after, the `web/http-search-request` record appended, number of model `web_search` calls so far | `index.js recordRequest` |
| 4 | raw vendor body (+ score ladder) → parsed `WebSearchResult`, or the `WebError` | `tavily.js parseResponse / describeError` |
| 5 | effective caps, governor-shaped value, per-source raw→parsed→shaped lengths, token cost | `shape.js`, `governor/index.js post-execute` |
| 6 | cache key, tokenize / Jaccard of a rephrased query | `similarity.js`, `cache.js` |
| 7 | governor ledger for this session | `ledger.js` |
| 8 | failure vocabulary | `describeError`, error mapping |

The command output never enters model history (`CommandResult.text` is rendered by the UI only). Steps 3 and 7 count **model-initiated** searches, so a good live sequence is: `/web-search-demo` → ask the model the same question → `/web-search-demo` again and point at the counters that moved.

## Install

```powershell
dsh plugin --profile web add ./packages/demo-command
```

Then refresh the Web GUI; `/web-search-demo` appears in the `/` menu. Settings section `web-search-demo` in `~/.dsh/settings.yaml` (hot-reloaded):

| Key | Default | |
| --- | --- | --- |
| `defaultQuery` | `蓝色大肥鱼` | used when no input is given |
| `maxResults` | `5` | passed to `ctx.web.search()` |
| `previewChars` | `160` | inline preview length before eliding |
| `showRawBody` | `true` | include the raw vendor body section |

Remove after the talk with `dsh plugin --profile web remove @baoson/dsh-web-search-demo-command`; no other package depends on it.

## How it captures the wire

The provider is not modified. For the duration of one search the command wraps `globalThis.fetch`, records the first request/response (headers redacted, body cloned) and restores the original in `finally`. There is no mocked or offline mode — every invocation is a real call through the configured provider. Terminal equivalents (also live): `pnpm demo` (`scripts/demo.js`) and `pnpm trace` (`scripts/trace-search.js`) at the monorepo root.
