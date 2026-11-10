# @tobedone4byme/dsh-web-fetch-readability

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) plugin that registers a **fetch provider** (id `readability-http`) for DSH's built-in `web_fetch` tool.

Stock DSH ships the `web_fetch` tool but **no fetch provider**, so the tool cannot work even when enabled. This package fills that gap with two goals:

1. **Security.** `dsh-tool-web` performs zero URL validation, and the URL comes from the model. This provider refuses non-http(s) schemes, reserved hostnames (`localhost`, `*.local`, `*.internal`, …) and any target whose DNS answer contains a private / loopback / link-local / multicast address — re-checked on **every redirect hop** — and enforces size and time limits with a streamed byte cap.
2. **Token reduction.** HTML goes through Mozilla Readability (over `linkedom`, no jsdom). The model receives `<h1>title</h1>` + the article body instead of menus, sidebars, cookie banners, inline scripts and styles. On the bundled test fixture that is **25 048 → 6 123 chars (−76 %)** before Markdown conversion; the official tool then converts the returned HTML to Markdown. Non-article pages fall back to a cleaned full page (scripts, styles, nav, footer, aside, forms, hidden elements removed).

## Pipeline

```
web_fetch({ url })
  → ctx.web.fetch → provider.fetch(req, signal)
      → assertSafeUrl        scheme, hostname block-list, DNS lookup, private-IP check
      → download             manual redirects (≤ maxRedirects, each hop re-validated),
                             timeout, streamed body capped at maxBodyBytes
      → decodeBody           charset: header → BOM → <meta charset> sniff → UTF-8
      → route by media type  HTML  → Readability | cleaned page → cap → { kind:'html' }
                             text/JSON/XML        → cap             → { kind:'text' }
                             application/pdf      → pdf.js text layer → cap → { kind:'text' }
                             anything else (images, archives, …) → "Unsupported content type" note
                             non-2xx → { statusCode, body: 'HTTP 404 Not Found for <url> …' }
```

Errors the provider *throws* are `WebError`s: `WEB_PROVIDER_ERROR` for blocked URLs, redirect-limit violations, timeouts and network failures; `WEB_ABORTED` when the caller's signal fires. Non-2xx responses, unsupported content types and unreadable PDFs are **results**, not errors, per the `dsh-web` contract.

### PDF support

`application/pdf` (and `application/x-pdf`) responses are handed to [pdf.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`, legacy Node build, loaded lazily on the first PDF so the HTML path stays cheap; no canvas, no worker thread). The provider returns `kind: 'text'`:

```
# <document title, or the URL's file name when the PDF has none>

<page 1 text>

<page 2 text>
…
```

- **What is extracted:** the text layer of each page — items are joined into lines using pdf.js's end-of-line flags and horizontal gaps, whitespace is collapsed, pages are separated by a blank line. The title comes from the PDF `Info` dictionary or XMP `dc:title`.
- **Limits:** reading stops after `pdf.maxPages` pages or `pdf.maxChars` characters (a `[truncated: read N of M pages …]` trailer is appended and `truncated: true` reported); `maxOutputChars` still applies on top. The download cap `maxBodyBytes` applies to the PDF bytes: a PDF larger than that is **not** parsed from a half file — you get a note asking to raise `maxBodyBytes` or use another extractor.
- **Not extracted:** images, layout, tables as tables, form fields, annotations. **Scanned / image-only PDFs have no text layer and yield an explanatory note** — there is no OCR here; use `tavily-extract` (or another OCR-capable extractor) as the fallback for those.
- **Failures:** encrypted (password-protected), corrupt or truncated PDFs produce an `Unsupported content type "application/pdf" … : Could not read PDF: …` note instead of a tool error. Set `pdf.enabled: false` to restore the old behaviour (plain "unsupported" note, no pdf.js loaded).

## Configuration

Row `web-fetch-readability` in `cordis.patch.yml`, or the hot-reloaded `web-fetch-readability:` section of `~/.dsh/settings.yaml`.

| Key | Default | Notes |
| --- | --- | --- |
| `maxOutputChars` | `20000` | Cap on the returned body. HTML gets `<p><em>[truncated: shown N of M chars]</em></p>`, text gets `\n[truncated: shown N of M chars]`. |
| `maxBodyBytes` | `5242880` | 5 MB download ceiling; the stream is cancelled beyond it and `truncated: true` is reported. |
| `timeoutMs` | `20000` | Budget for the whole request (all hops + body read). Keep it below the tool's own timeout so the error is ours, not a kill. |
| `maxRedirects` | `5` | 6th redirect → `WEB_PROVIDER_ERROR`. Only GET is ever issued. |
| `userAgent` | `dsh-web-fetch-readability/0.1.0` | |
| `acceptLanguage` | `en-US,en;q=0.8` | |
| `allowPrivate` | `false` | **Debug only.** Permits loopback / RFC 1918 / link-local targets and reserved hostnames. |
| `readability` | `true` | `false` → always return the cleaned full page. |
| `allowedContentTypes` | `text/html`, `application/xhtml+xml`, `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/xml`, `text/xml`, `application/ld+json` | Exact types or `type/*` wildcards. Others return an "unsupported" note. `application/pdf` is routed to the PDF extractor whenever `pdf.enabled` is true and need not be listed here. |
| `pdf.enabled` | `true` | Extract the text layer of PDFs with pdf.js. `false` → PDFs get the plain "unsupported" note and pdf.js is never loaded. |
| `pdf.maxPages` | `30` | Pages read from the start of the document; the rest is skipped and flagged `truncated`. |
| `pdf.maxChars` | `20000` | Cap on extracted PDF text (same default as `maxOutputChars`, which still applies afterwards). |

Supported charsets: whatever Node's ICU `TextDecoder` knows — UTF-8/16, GBK/GB2312/GB18030, Big5, Shift_JIS, EUC-KR, ISO-8859-x / Windows-125x. Unknown labels fall back to UTF-8.

## Install and mount

```powershell
dsh plugin --profile web add @tobedone4byme/dsh-web-fetch-readability   # or ./packages/fetch-readability
```

The package ships a bundle patch (`cordis.patch.yml`) that inserts the provider row and sets the web seam's `fetchProvider: readability-http`. To tune it, add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: web-fetch-readability
  name: '@tobedone4byme/dsh-web-fetch-readability'
  config:
    maxOutputChars: 20000
    timeoutMs: 20000

- id: web
  config:
    fetchProvider: readability-http
```

## IMPORTANT: enabling `web_fetch` itself

Registering a provider is not enough — the official `tool-web` row ships with `fetch: false`, and where that row lives depends on how you run DSH:

### DSH Web GUI (agent presets)

In the Web GUI `@deepseek-ai/dsh-tool-web` is mounted **per agent preset** (the profile-level row is disabled and each preset remounts it), so a profile `cordis.patch.yml` cannot flip it. Create a user preset instead:

1. Copy the shipped preset directory
   `C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\config\agent-presets\standard\`
   (both `agent.cordis.yml` and `preset.yml`) to
   `$DSH_HOME/.agent-presets/<your-id>/` (default `DSH_HOME` is `~/.dsh`).
2. In the copied `agent.cordis.yml` find the `tool-web` row and change it:

   ```yaml
   - id: tool-web
     name: '@deepseek-ai/dsh-tool-web'
     config:
       fetch: true          # was: false
       searchTimeoutMs: 60000
   ```

3. Give the preset a distinct `id` / label in `preset.yml`, restart or refresh DSH, and pick that preset in the GUI.

### Headless / CLI profiles

There the `tool-web` row is profile-level; patch it in `cordis.patch.yml`:

```yaml
- id: tool-web
  config:
    fetch: true
```

## Verify

- Fetch a real article → Markdown starting with `# <title>`, under ~20 000 chars.
- `web_fetch http://127.0.0.1:3080/` → `Blocked URL … private, loopback and link-local targets are refused`.
- Fetch a 404 → `HTTP 404 … for <url>` result, not a tool error.
- Fetch a PDF link → text starting with `# <title>`; a scanned PDF → "No text layer found" note.

## Development

```powershell
# from the monorepo root
node node_modules/vitest/vitest.mjs run packages/fetch-readability
```

Tests never touch the real network: fixture servers run on `127.0.0.1` with `allowPrivate: true` (or a hostname predicate so redirect targets are still checked), and DNS is injected via the `lookup` option.

```
lib/
  index.js     plugin + ReadabilityFetchProvider, content-type routing, error mapping
  ssrf.js      isAllowedScheme, isBlockedHostname, isPrivateAddress, assertSafeUrl
  download.js  redirect loop, timeout, streamed byte cap
  decode.js    charset detection + TextDecoder
  extract.js   Readability / fallback cleaner, capHtml, capText
  pdf.js       extractPdfText (lazy pdfjs-dist), line-joining heuristics
```

Test PDFs are generated in-process by `test/pdf-fixtures.js` (hand-written PDF syntax with exact xref offsets), so no PDF-authoring dependency is needed.

## Limitations

- PDF extraction is text-layer only: no OCR for scanned PDFs, no tables/forms/images (see *PDF support*; `tavily-extract` is the fallback).
- No pagination: `WebFetchRequest` is `{ url }` only; needs an upstream change.
- Readability runs over `linkedom`, which is lighter than jsdom but not a full browser DOM; pages that rely on exotic DOM APIs may land in the fallback path. `readability: false` is the escape hatch.
