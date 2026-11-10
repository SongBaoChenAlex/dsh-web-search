# @tobedone4byme/dsh-web-search-governor

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that stops `web_search` from eating your context window. Works with **any** search provider (DSH's built-in `deepseek-official`, Tavily, Brave, …) because it only looks at the tool's result shape. It never calls the network or a model — zero added tokens.

| Layer | Hook | What happens |
| --- | --- | --- |
| **Cache** | `tools/execute` | A repeated query (case/whitespace/punctuation-insensitive) in the same session returns the earlier result; the provider is not called. |
| **Near-duplicate** | `tools/execute` + `tools/post-execute` | A *rephrased* repeat of an earlier query in the same session is flagged: a one-line note is prepended to the results (`notice`) or the provider is skipped (`block`). |
| **Budget** | `tools/execute` | After `budgetPerSession` searches the tool returns a short notice instead of results, without calling the provider. |
| **Shaping** | `tools/post-execute` | Dedupe by cleaned URL, strip `utm_*`/`fbclid`/…, cap snippet and answer length, cap the source count. Returned as a replacement **value**, so the official tool re-renders the text and the UI card. |
| **Accounting** | `tools/post-execute` | Per-session ledger of raw vs shaped tokens, plus one `ctx.logger.info` line per governed search. |
| **Guidance** | `systemPrompt.section` | A short "use web search responsibly" paragraph right after DSH's own `tool:web_search` section (order 111). |

Every arm is wrapped in `try/catch`: a governor bug falls through to stock behaviour.

## Install & mount

```powershell
dsh plugin --profile web add @tobedone4byme/dsh-web-search-governor   # or ./packages/search-governor
```

The bundled `cordis.patch.yml` inserts the row with defaults. To override, add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: web-search-governor
  name: '@tobedone4byme/dsh-web-search-governor'
  config:
    maxSources: 5
    snippetMaxChars: 300
    contentMaxChars: 1500
    budgetPerSession: 10
    activeProvider: tavily          # picks providerOverrides.tavily
    providerOverrides:
      tavily: { snippetMaxChars: 800 }
```

Live overrides (hot-reloaded) go under `web-search-governor:` in `~/.dsh/settings.yaml`.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `maxSources` | `5` | Sources kept after dedupe; `0` = unlimited. Sets `truncated: true` when some were dropped. |
| `snippetMaxChars` | `300` | Per-source snippet cap; `0` = unlimited |
| `contentMaxChars` | `1500` | Cap for the provider's synthesized answer; `0` = unlimited |
| `budgetPerSession` | `10` | `web_search` calls per session; `0` disables the budget |
| `budgetNotice` | built-in text | Returned instead of results once exhausted |
| `stripTrackingParams` | `true` | Removes `utm_*`, `fbclid`, `gclid`, `mc_cid`, … (dedupe always ignores them) |
| `guidance` | `true` | Register the system-prompt section |
| `cache` | `true` | Same-query cache per session (max 50 entries) |
| `cacheTtlMs` | `1800000` | 30 minutes |
| `nearDuplicate` | `true` | Flag rephrased repeats of an earlier query in the same session (last 50 queries) |
| `nearDuplicateThreshold` | `0.5` | Jaccard similarity of stemmed, stop-word-free tokens at or above which a query is a near-duplicate |
| `nearDuplicateMode` | `"notice"` | `notice` prepends one line to the results; `block` skips the provider and returns the earlier cached result (or a notice if it expired) |
| `logAccounting` | `true` | Emit one `ctx.logger.info` line per governed search (see [Accounting](#accounting)) |
| `providerOverrides` | `{ tavily: { snippetMaxChars: 800 } }` | Per-provider-id partial overrides of the four caps |
| `activeProvider` | – | Which override applies. The result value carries no provider id, so set this to the `web` row's `searchProvider`. |

Sessions are keyed by `exec.agent.session.header.id` (`anonymous` when absent). Budget, cache, query history and ledger live in memory, LRU-bounded to 500 sessions.

## Near-duplicate detection

The cache only catches *identical* queries. Models under "search addiction" rephrase instead: `node 24 fetch timeout` → `node 24 fetch timeout setting`. The governor tokenizes both (lowercase, punctuation stripped, English stop-words and single characters dropped, light `s`/`es`/`ed`/`ing` stemming) and compares them with Jaccard similarity: here `{node, 24, fetch, timeout}` vs `{node, 24, fetch, timeout, setting}` → 4 / 5 = **0.8** ≥ 0.6.

- **`notice`** (default) — the search runs, but the shaped result's `content` starts with:

  ```
  Note: this query closely matches an earlier search ("node 24 fetch timeout", similarity 0.8); if the results overlap, stop searching and answer.
  ```

- **`block`** — the provider is not called and no budget is spent. If the earlier result is still cached it is returned (with `meta.governor = { cached: true, nearDuplicate: { of, score } }`); otherwise a notice result (same shape as the budget notice) tells the model the query is a near-duplicate and to reuse those results or change the angle.

Identical queries are served by the cache first and are never counted as near-duplicates. Pure functions live in `lib/similarity.js` (`tokenize`, `jaccard`, `findNearDuplicate`).

## Accounting

Every governed search updates a per-session ledger `{ searches, rawTokens, shapedTokens, cacheHits, budgetBlocks, nearDuplicates }`, where `rawTokens` is `estimateTokens(JSON of the provider value before shaping)` and `shapedTokens` the same after shaping. Read it with `ledgerOf(sessionKey)` (exported from the package) or from the `applyWith(...)` handle: `{ budget, cache, history, ledger, current }`. Cache hits count as `cacheHits`, not as searches.

With `logAccounting: true` and a `ctx.logger`, one line is emitted per governed search:

```
web_search governed: raw≈1830 tok → 410 tok (−78%), session 3/10, cache miss
```

The trailing state is `cache miss`, `cache hit` or `near-duplicate`; an unlimited budget shows as `3/∞`.

## Testing

```powershell
pnpm test            # repo root, vitest, no network
```

Tests drive the registered `tools/execute` / `tools/post-execute` handlers through a fake `ctx`. The `@deepseek-ai/dsh-settings` integration is loaded with a dynamic `import()` inside `apply` (and injectable via `applyWith(ctx, config, { installSettings })`), so the test suite never imports the DSH host.
