# Structured Memory Engine

SQLite FTS5-powered memory system for AI workspaces. Indexes markdown memory files, extracts structured facts, and maintains memory health over time — all offline, zero API calls, single dependency.

## What it does

| Layer | Version | Purpose |
|-------|---------|---------|
| **Recall** | v1 | Full-text search over markdown files with ranked results and citations |
| **Retain** | v2 | Convention-based fact extraction with confidence scoring |
| **Reflect** | v3 | Memory lifecycle — decay, reinforcement, staleness, contradiction detection, pruning |

## Quick start

```bash
npm install

# Index a workspace
node lib/index.js index --workspace /path/to/workspace

# Search
node lib/index.js query "search terms"

# Run memory maintenance
node lib/index.js reflect --dry-run
```

## How it works

1. Scans markdown files: `MEMORY.md`, `USER.md`, `SOUL.md`, `TOOLS.md`, `STATE.md`, `VOICE.md`, `IDENTITY.md`, `memory/*.md`
2. Chunks by heading or paragraph break (~2000 char max per chunk)
3. Extracts tagged facts with confidence scores (`[confirmed]` = 1.0, `[inferred]` = 0.7, `[outdated?]` = 0.3)
4. Stores everything in SQLite FTS5 at `{workspace}/.memory/index.sqlite`
5. Returns ranked results: BM25 relevance x recency boost x file weight x confidence

Incremental by default — only re-indexes files whose mtime changed.

## Commands

```bash
# Indexing
node lib/index.js index [--workspace PATH] [--force] [--include extra.md,other.md]

# Search
node lib/index.js query "terms" [--limit N] [--since 7d|2w|3m|1y|2026-01-01]
                                 [--context N] [--type fact|confirmed|inferred|...]
                                 [--min-confidence 0.5] [--include-stale]

# Status
node lib/index.js status [--workspace PATH]

# Memory maintenance
node lib/index.js reflect [--dry-run] [--workspace PATH]
node lib/index.js contradictions [--unresolved] [--limit N]
node lib/index.js archived [--limit N]
node lib/index.js restore <chunk-id>
```

## Fact tagging (v2)

Tag lines in your markdown for structured extraction:

```markdown
[fact] Takes bromantane 25mg sublingual daily
[decision] FTS5 over vector DB for search
[confirmed] Height is 6'5"
[inferred] Prefers warm lighting
[outdated?] Takes 1.75mg retatrutide
```

Untagged bullets under headings like `## Decisions`, `## Facts`, `## Preferences`, `## Learned` are auto-classified.

## Memory lifecycle (v3)

The `reflect` command runs a full maintenance cycle:

- **Decay** — Confidence decreases over time. `confirmed` is immune. `outdated` decays 2x faster.
- **Reinforce** — Frequently searched chunks get a confidence boost.
- **Stale** — Low confidence + old chunks are marked stale and excluded from search.
- **Contradictions** — Same-heading chunks with shared terms and negation signals are flagged.
- **Prune** — Very stale chunks are archived (never deleted, always restorable).

Use `--dry-run` to preview changes before applying.

## Ranking

Results are scored by four factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| FTS5 BM25 | base | Keyword relevance |
| Recency | 1-2x | Linear decay over 90 days |
| File weight | 0.8-1.5x | MEMORY.md 1.5x, USER.md 1.3x, daily logs 1.0x |
| Confidence | 0-1x | `[confirmed]` ranks above `[outdated?]` |

## Custom aliases

Place `aliases.json` in `{workspace}/.memory/` for query expansion:

```json
{
  "job": ["work", "career", "employment"],
  "crypto": ["defi", "token", "chain", "wallet"]
}
```

## Design principles

1. **Markdown is source of truth** — the SQLite index is derived and fully rebuildable
2. **Read-only** — never modifies, deletes, or overwrites user files
3. **Offline-first** — no network, no API keys, no ongoing cost
4. **Single dependency** — just `better-sqlite3`
5. **Archive, never delete** — pruned memories are recoverable via `restore`

## Testing

```bash
npm test  # 49 tests (16 v2 + 33 v3)
```

## License

MIT
