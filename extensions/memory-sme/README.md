# OpenClaw Memory Plugin — SME

Drop-in replacement for `memory-core`. Replaces the default memory slot with Structured Memory Engine — FTS5 full-text search, confidence scoring, memory decay, contradiction detection, lifecycle management, and automatic context injection.

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
        "autoRecall": true,
        "autoRecallMaxTokens": 1500,
        "autoCapture": true,
        "captureMaxChars": 500,
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

## Lifecycle Hooks

### Auto-recall (`before_agent_start`)

Every agent turn, CIL extracts terms from the user's message, retrieves the most relevant memories, and injects them into the system prompt via `{ prependContext: string }`. The agent receives pre-ranked, confidence-weighted context without needing to call any tools.

- Enabled by default (`autoRecall: true`)
- Skips prompts shorter than 5 characters
- Token budget: 1500 (configurable via `autoRecallMaxTokens`)
- Follows the same `before_agent_start` → `{ prependContext }` pattern as `memory-lancedb`

### Auto-capture (`agent_end`)

After each agent turn, user messages are scanned for decisions, preferences, and facts using trigger patterns. Matched content is automatically saved to the daily memory log and indexed.

- Enabled by default (`autoCapture: true`)
- Max 3 captures per turn (avoids noise)
- Long messages truncated to `captureMaxChars` (default 500)
- Trigger patterns: decisions ("decided", "going with", "settled on"), preferences ("prefer", "always use", "switched to"), facts ("learned", "realized", "turns out"), commitments ("agreed", "promised", "scheduled")
- Questions, greetings, and short messages are skipped

### Auto-index (`before_agent_start`)

Indexes workspace on startup. Disable with `autoIndex: false`.

### Shutdown (`dispose`)

Database handle is closed cleanly.

## Config Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workspace` | string | agent workspace | SME workspace path |
| `autoIndex` | boolean | `true` | Index on startup |
| `autoRecall` | boolean | `true` | Inject relevant memories before each turn |
| `autoRecallMaxTokens` | number | `1500` | Token budget for auto-injected context |
| `autoCapture` | boolean | `true` | Auto-save decisions/preferences/facts from user messages |
| `captureMaxChars` | number | `500` | Max characters per auto-captured memory |
| `fileTypeDefaults` | object | `{}` | Map file patterns to chunk types |
| `reflectInterval` | string | — | Auto-reflect interval (e.g. `6h`, `12h`) |

## What replaces what

| memory-core tool | SME tool | Difference |
|-----------------|----------|------------|
| `memory_search` | `memory_search` | FTS5 + confidence + recency ranking vs. runtime builtins |
| `memory_get` | `memory_get` | Same — reads file by path + line range |
| — | `memory_remember` | New — write path with auto-index |
| — | `memory_reflect` | New — memory lifecycle maintenance |
| — | auto-recall | New — automatic context injection via CIL |
| — | auto-capture | New — automatic memory creation from user messages |
