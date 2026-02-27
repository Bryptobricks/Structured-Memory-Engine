---
name: structured-memory-engine
description: >
  This skill should be used when the user asks to "search memory",
  "remember this", "run memory maintenance", "check memory status",
  "reflect on memories", or mentions SME, structured memory, memory decay,
  or contradiction detection. Provides FTS5-powered memory with confidence
  scoring, decay, and lifecycle management.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      anyBins: ["node"]
---

# Structured Memory Engine

Persistent, self-maintaining memory for AI agents. SQLite FTS5 full-text search with confidence scoring, memory decay, contradiction detection, and lifecycle management.

## Quick Start

Set environment variables:

```bash
export SME_PATH="/path/to/Structured-Memory-Engine"
export SME_WORKSPACE="$HOME/.openclaw/workspace"  # or any workspace dir
```

## Tools

### Search Memory

Find memories by keyword with ranked results:

```bash
bash scripts/sme-query.sh "search terms"
bash scripts/sme-query.sh "aave health factor" --limit 5 --since 7d
bash scripts/sme-query.sh "supplement protocol" --type confirmed --min-confidence 0.8
```

Options: `--limit N`, `--since 7d|2w|3m|1y|YYYY-MM-DD`, `--type fact|confirmed|inferred|...`, `--min-confidence 0.0-1.0`, `--include-stale`

Returns JSON with ranked results including file path, line numbers, score, and content.

### Remember Something

Save a fact, decision, or preference:

```bash
node scripts/sme-remember.js "decided to use FTS5 over vector search" decision
node scripts/sme-remember.js "takes bromantane 25mg daily" fact
node scripts/sme-remember.js "prefers dark terminal themes" pref
```

Tags: `fact` (default), `decision`, `pref`, `opinion`, `confirmed`, `inferred`

### Run Memory Maintenance

Decay, reinforce, detect contradictions, prune stale memories:

```bash
bash scripts/sme-reflect.sh
bash scripts/sme-reflect.sh --dry-run  # preview without applying
```

### Check Status

```bash
bash scripts/sme-status.sh
```

Shows file count, chunk count, and index health.

### Index Workspace

Re-index all workspace files (runs automatically on startup):

```bash
node "$SME_PATH/lib/index.js" index --workspace "$SME_WORKSPACE"
node "$SME_PATH/lib/index.js" index --workspace "$SME_WORKSPACE" --force  # full rebuild
```

## Configuration

Create `$SME_WORKSPACE/.memory/config.json`:

```json
{
  "owner": "JB",
  "include": ["CLAUDE.md", "TOOLS.md"],
  "includeGlobs": ["agents/*.md", "skills/*.md"],
  "fileTypeDefaults": {
    "MEMORY.md": "confirmed",
    "memory/*.md": "fact",
    "plans/*.md": "inferred"
  }
}
```

## How It Works

1. **Recall** — FTS5 full-text search over indexed markdown with BM25 + recency + confidence ranking
2. **Retain** — Convention-based fact extraction (`[fact]`, `[decision]`, `[confirmed]`, etc.)
3. **Reflect** — Memory lifecycle: decay, reinforcement, staleness, contradiction detection, pruning
4. **Remember** — Write path: saves to daily log, immediately indexed and searchable
