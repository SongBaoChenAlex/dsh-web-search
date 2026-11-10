# @baoson/dsh-web-fetch-composite

A `web_fetch` provider for the DeepSeek Harness web seam (`ctx.web`) that **chains other registered fetch providers**. Registers under id **`composite`**.

## Why

`readability-http` (local, free, cleanest output) handles most pages. SPAs, anti-bot front doors and PDFs come back as an empty shell, a 403/429, or an error — and then `tavily-extract` (hosted, renders JS, reads PDFs, costs credits) is the right tool. `composite` makes that fallback automatic, so the model does not have to notice the thin result and retry, and the paid provider is only used when the free one actually failed.

## Configuration

Static config lives on the `web-fetch-composite` row; the same keys are hot-reloadable from the `web-fetch-composite:` section of `~/.dsh/settings.yaml`.

| Key | Default | Meaning |
| --- | --- | --- |
| `chain` | `["readability-http", "tavily-extract"]` | Provider ids to try in order. Missing / unavailable ids and `composite` itself are skipped. |
| `minTextChars` | `400` | A result with fewer visible characters (tags stripped for `html`, raw for `text`) is *thin* and triggers the next provider. `0` disables. |
| `fallbackOnStatus` | `[403, 429, 451, 500, 502, 503]` | HTTP status codes that trigger the next provider. |
| `fallbackOnError` | `true` | Try the next provider when the current one throws. Aborts always propagate. |
| `notice` | `true` | After a fallback, prepend one line (`<!-- fetched via tavily-extract after readability-http returned thin content (12 chars) -->` for HTML, `[…]` for text) so the transcript shows who served the page. |

## Selecting it

The bundled `cordis.patch.yml` inserts the row and points the seam at it:

```yaml
- insert:
    - id: web-fetch-composite
      name: '@baoson/dsh-web-fetch-composite'
      config: {}
- id: web
  config:
    fetchProvider: composite
```

The providers named in `chain` must be installed too (e.g. `@baoson/dsh-web-fetch-readability`, `@baoson/dsh-web-tavily-tools`); they are looked up lazily on every call, so row order does not matter.

## Decision flow

1. Resolve `chain` against `ctx.web.fetchProviders`, dropping unknown ids, providers whose `available()` is false, and `composite`. Nothing left → `WebError` `WEB_PROVIDER_ERROR`.
2. For each provider in order (checking the abort signal between attempts):
   - throws → next (if `fallbackOnError`), abort → rethrow as `WEB_ABORTED`;
   - `statusCode` in `fallbackOnStatus` → next;
   - visible text `< minTextChars` → remember it, next;
   - otherwise → return it (with the notice if anything was skipped before).
3. Everyone was thin → return the **longest** thin result (not the last).
4. Nothing returned at all → `WEB_PROVIDER_ERROR` listing each provider's reason.

The winning result is passed through unchanged except for the optional notice prefix on `body.content`.

`isThin(result, minTextChars)` and `textLengthOf(result)` are exported for tests.
