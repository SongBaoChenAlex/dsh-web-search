# @tobedone4byme/dsh-image-retention

DeepSeek Harness plugin: keep only the **last N images** in each model request.
Older images (pasted into the chat, or produced by `read_image` inside a tool
result) are replaced with a short text placeholder before the request reaches
the provider.

- The session log and the GUI history are **not** modified — earlier images are
  still visible in the conversation; they just aren't re-sent to the model.
- Works for the main agent and all subagents (hooks the shared `llm/stream`
  waterfall with `prepend: true`).
- Zero network / model cost; pure message transform.

## Install (profile)

Already wired into `~/.dsh/profiles/web/package.json` as a `link:` dependency
and listed under `dsh.profile.bundles`. Restart `dsh web` to activate.

## Config

Override in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: image-retention
  config:
    keepLast: 1                                  # images to keep (default 1)
    placeholder: "[earlier image omitted from context]"
    agentLoopOnly: true                          # skip title/compaction side calls
```

`keepLast: 0` strips every image; disable the row entirely with
`- id: image-retention` + `disabled: true`.

## Why not rewrite the session?

`dsh-session` only allows surface replacements that cite every shadowed node
(`compaction/*`) or tool-result content rewrites. A user message with an image
can't be edited in place without a compaction-style summary event. Filtering at
request time is simpler, reversible, and replay-safe.
