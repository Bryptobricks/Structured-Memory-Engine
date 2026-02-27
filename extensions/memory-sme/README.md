# OpenClaw Memory Plugin — SME

Drop-in replacement for `memory-core`. Replaces the default memory slot with Structured Memory Engine — FTS5 full-text search, confidence scoring, memory decay, contradiction detection, and lifecycle management.

## Setup

### 1. Point OpenClaw at the plugin

In your OpenClaw config (`openclaw.config.json` or settings):

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/Structured-Memory-Engine/extensions"]
    },
    "slots": {
      "memory": "memory-sme"
    }
  }
}
```

### 2. Configure (optional)

Plugin-level config in your OpenClaw settings:

```json
{
  "plugins": {
    "config": {
      "memory-sme": {
        "workspace": "/path/to/workspace",
        "autoIndex": true,
        "fileTypeDefaults": {
          "MEMORY.md": "confirmed",
          "memory/*.md": "fact"
        }
      }
    }
  }
}
```

If `workspace` is omitted, defaults to the agent's workspace directory.

### 3. Air-gapped install

On the air-gapped machine:

```bash
# Clone SME (already done if you have it)
cd /path/to/Structured-Memory-Engine
npm install

# Point OpenClaw at extensions/
# In openclaw config:
#   plugins.load.paths = ["/path/to/Structured-Memory-Engine/extensions"]
#   plugins.slots.memory = "memory-sme"
```

No npm registry needed. The plugin resolves `structured-memory-engine` from the parent repo.

## Tools Registered

| Tool | Description |
|------|-------------|
| `memory_search` | FTS5 search with ranked results, confidence filtering, time ranges |
| `memory_get` | Read file by path + optional line range |
| `memory_remember` | Save fact/decision/preference to daily log (auto-indexed) |
| `memory_reflect` | Run maintenance: decay, reinforce, stale, contradictions, prune |

## Lifecycle

- **Startup**: Auto-indexes workspace (disable with `autoIndex: false`)
- **No auto-capture**: Memory is explicit — user says "remember this", not automatic on every turn
- **Shutdown**: Database handle is closed cleanly via `dispose()`

## What replaces what

| memory-core tool | SME tool | Difference |
|-----------------|----------|------------|
| `memory_search` | `memory_search` | FTS5 + confidence + recency ranking vs. runtime builtins |
| `memory_get` | `memory_get` | Same — reads file by path + line range |
| — | `memory_remember` | New — write path with auto-index |
| — | `memory_reflect` | New — memory lifecycle maintenance |
