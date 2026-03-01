---
name: structured-memory-engine
description: >
  Structured memory system for AI workspaces. Indexes markdown memory files into SQLite FTS5
  for fast, cited search. Extracts structured facts, maintains memory health, and provides
  an MCP server with live search + write-path for Claude Code integration.
---

# Structured Memory Engine

## MCP Tools (v4)

When running as an MCP server (`node lib/mcp-server.js`), exposes:

- `sme_query` — Search memory. Supports `query`, `limit`, `since`, `type`, `minConfidence`, `includeStale`.
- `sme_context` — Get relevant context for a message. Returns ranked, token-budgeted, formatted context for injection. Supports `message`, `maxTokens`.
- `sme_remember` — Save a fact/decision/preference to today's memory log. Auto-indexed.
- `sme_index` — Re-index workspace. Use `force: true` for full rebuild.
- `sme_reflect` — Run maintenance: decay, reinforce, stale detection, contradictions, prune. Use `dryRun: true` to preview.
- `sme_status` — Index statistics.

## CLI Commands

```bash
# Index workspace memory files
node lib/index.js index [--workspace PATH] [--force] [--include extra.md,other.md]

# Search indexed memory
node lib/index.js query "search terms" [--limit N] [--since 7d|2w|3m|2026-01-01]
                                        [--context N] [--type fact|confirmed|inferred|...]
                                        [--min-confidence 0.5] [--include-stale]

# Show index status
node lib/index.js status [--workspace PATH]

# Memory maintenance
node lib/index.js reflect [--workspace PATH] [--dry-run]
node lib/index.js contradictions [--workspace PATH] [--unresolved]
node lib/index.js archived [--workspace PATH] [--limit N]
node lib/index.js restore <chunk-id> [--workspace PATH]
```

## Configuration

Config file: `{workspace}/.memory/config.json`

```json
{
  "owner": "Alex",
  "include": ["CLAUDE.md", "TOOLS.md"],
  "includeGlobs": ["agents/*.md", "skills/*.md", "plans/*.md"],
  "fileTypeDefaults": {
    "MEMORY.md": "confirmed",
    "USER.md": "confirmed",
    "memory/*.md": "fact",
    "plans/*.md": "inferred"
  }
}
```

- `owner` — Personalizes MCP tool descriptions
- `include` — Explicit file paths to index beyond defaults
- `includeGlobs` — Glob patterns for additional files
- `fileTypeDefaults` — Map file patterns to chunk types (activates confidence system without inline tags)

## Fact Tagging

```markdown
[fact] Content here        → type: fact, confidence: 1.0
[decision] Content here    → type: decision, confidence: 1.0
[pref] Content here        → type: preference, confidence: 1.0
[confirmed] Content here   → type: confirmed, confidence: 1.0
[opinion] Content here     → type: opinion, confidence: 0.8
[inferred] Content here    → type: inferred, confidence: 0.7
[outdated?] Content here   → type: outdated, confidence: 0.3
```

Untagged bullets under `## Decisions`, `## Facts`, `## Preferences`, `## Learned`, `## Open Questions` headings are auto-classified (confidence: 0.9).

## Session Hooks

For auto-index on session start and reflect on session end:

```bash
# Index hook (session start)
node bin/sme-hook.js index

# Reflect hook (session end)
node bin/sme-hook.js reflect
```

Set `SME_WORKSPACE` env var to override the default workspace (`~/.claude`).
