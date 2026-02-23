---
name: structured-memory-engine
description: >
  Structured memory recall for OpenClaw workspaces. Indexes markdown memory files
  (MEMORY.md, memory/*.md) into SQLite FTS5 for fast, cited search.
  Use when needing to recall past decisions, facts, preferences, or context from
  workspace memory files. Layers on top of existing memory — does not replace markdown files.
---

# Structured Memory Engine

## Commands

```bash
# Index workspace memory files into SQLite FTS5
node lib/index.js index [--workspace /path/to/workspace] [--force]

# Search indexed memory
node lib/index.js query "what did we decide about X" [--limit 10] [--since 7d]

# Show index status
node lib/index.js status [--workspace /path/to/workspace]
```

## How it works

1. Scans MEMORY.md, memory/*.md, and any configured markdown paths
2. Chunks by heading (## / ###) or paragraph breaks
3. Stores in SQLite FTS5 at `{workspace}/.memory/index.sqlite`
4. Returns ranked results with file path + line number citations

Incremental by default — only re-indexes files whose mtime changed. Use `--force` for full rebuild.
