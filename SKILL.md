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
node lib/index.js index [--workspace /path/to/workspace] [--force] [--include extra.md,other.md]

# Search indexed memory
node lib/index.js query "search terms" [--limit N] [--since 7d|2w|3m|2026-01-01] [--context N]

# Show index status
node lib/index.js status [--workspace /path/to/workspace]
```

## How it works

1. Scans MEMORY.md, SOUL.md, USER.md, TOOLS.md, STATE.md, VOICE.md, IDENTITY.md, and `memory/*.md`
2. Chunks by heading (## / ###) or paragraph breaks (max ~2000 chars per chunk)
3. Stores in SQLite FTS5 at `{workspace}/.memory/index.sqlite`
4. Returns ranked results with file path + line number citations

Incremental by default — only re-indexes files whose mtime changed. Use `--force` for full rebuild.

## Ranking

Results are ranked by three factors:
- **FTS5 BM25** — keyword relevance
- **Recency boost** — recent content scores higher (linear decay over 90 days)
- **File weight** — curated files rank higher (MEMORY.md 1.5x, USER.md 1.3x, daily logs 1.0x)

## v2 Retain — Structured Fact Extraction

Tag markdown content for structured extraction with confidence scoring:

```
[fact] JB takes bromantane 25mg sublingual daily        → type: fact, confidence: 1.0
[decision] FTS5 over vector DB for v1                   → type: decision, confidence: 1.0
[pref] No over-engineering, minimum complexity           → type: preference, confidence: 1.0
[confirmed] JB's height is 6'5"                         → type: confirmed, confidence: 1.0
[opinion] Bromantane is better than Adderall             → type: opinion, confidence: 0.8
[inferred] JB prefers warm lighting                     → type: inferred, confidence: 0.7
[outdated?] JB takes 1.75mg retatrutide                 → type: outdated, confidence: 0.3
```

Untagged bullets under `## Decisions`, `## Facts`, `## Preferences`, `## Learned`, `## Open Questions` headings are auto-classified (confidence: 0.9).

### Query Filters

```bash
# Filter by type
node lib/index.js query "bromantane" --type fact

# Filter by minimum confidence (excludes outdated/low-confidence)
node lib/index.js query "bromantane" --min-confidence 0.5

# Combine filters
node lib/index.js query "lighting" --type preference --min-confidence 0.7
```

Confidence affects ranking: `[outdated?]` items (0.3) naturally rank lower than `[confirmed]` items (1.0).

## Options

- `--since` — temporal filter. Supports: `7d` (days), `2w` (weeks), `3m` (months), `1y` (years), or absolute `2026-01-01`
- `--context N` — return N adjacent chunks before/after each result for surrounding context
- `--include` — comma-separated additional file paths to index beyond defaults
- `--force` — full reindex (ignore mtime cache)

## Custom aliases

Place an `aliases.json` file in `{workspace}/.memory/` to customize query expansion.
Keys replace defaults (not extend). See `examples/aliases.json` for the format.

```json
{
  "job": ["work", "career", "employment"],
  "crypto": ["defi", "token", "chain", "wallet"]
}
```
