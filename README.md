# Structured Memory Engine

Persistent, self-maintaining memory for AI agents. Indexes markdown files into a SQLite FTS5 database, extracts structured facts with confidence scoring, and runs its own memory lifecycle — decay, reinforcement, contradiction detection, and pruning. Exposes everything through an MCP server and a JSON-capable CLI. No API calls, no cloud, no ongoing cost. One dependency. Your AI remembers everything, forever.

## What it does

| Layer | Version | Purpose |
|-------|---------|---------|
| **Recall** | v1 | Full-text search over markdown files with ranked results and citations |
| **Retain** | v2 | Convention-based fact extraction with confidence scoring |
| **Reflect** | v3 | Memory lifecycle — decay, reinforcement, staleness, contradiction detection, pruning |
| **Reach** | v4 | MCP server for Claude Code — live search, write-path, config, file-level type defaults, JSON API |

## Setup on a new device

### 1. Clone and install

```bash
git clone https://github.com/chainseeker44/Structured-Memory-Engine.git
cd Structured-Memory-Engine
npm install
```

### 2. Create workspace config

Create `{workspace}/.memory/config.json` (default workspace is `~/.claude`):

```bash
mkdir -p ~/.claude/.memory
cp examples/config.json ~/.claude/.memory/config.json
# Edit to match your workspace structure
```

See [examples/config.json](examples/config.json) for a complete reference config.

### 3. Register as MCP server in Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "sme": {
      "command": "node",
      "args": ["/absolute/path/to/Structured-Memory-Engine/lib/mcp-server.js"],
      "env": {
        "SME_WORKSPACE": "/absolute/path/to/workspace"
      }
    }
  }
}
```

If `SME_WORKSPACE` is omitted, defaults to `~/.claude`.

### 4. (Optional) Session hooks

Add to `~/.claude/settings.json` for auto-index on session start and reflect on session end:

```json
{
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/Structured-Memory-Engine/bin/sme-hook.js index"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/Structured-Memory-Engine/bin/sme-hook.js reflect"
          }
        ]
      }
    ]
  }
}
```

### 5. Verify

```bash
# CLI check
node lib/index.js index --workspace ~/.claude
node lib/index.js status --workspace ~/.claude

# MCP server check — starts on stdio, ctrl+c to stop
node lib/mcp-server.js
```

## Configuration

Config lives at `{workspace}/.memory/config.json`. All fields are optional.

```json
{
  "owner": "JB",
  "include": ["CLAUDE.md", "TOOLS.md"],
  "includeGlobs": ["agents/*.md", "skills/*.md", "plans/*.md"],
  "fileTypeDefaults": {
    "MEMORY.md": "confirmed",
    "USER.md": "confirmed",
    "CLAUDE.md": "confirmed",
    "TOOLS.md": "confirmed",
    "memory/*.md": "fact",
    "agents/*.md": "fact",
    "skills/*.md": "fact",
    "plans/*.md": "inferred"
  }
}
```

| Field | Purpose |
|-------|---------|
| `owner` | Personalizes MCP tool descriptions ("Search JB's memory...") |
| `include` | Explicit file paths to index beyond defaults |
| `includeGlobs` | Glob patterns for additional files (`dir/*.md`, `dir/**/*.md`) |
| `fileTypeDefaults` | Map file patterns to chunk types — activates the confidence system without inline tags |

### File-level type defaults (v4.2)

Maps file paths/patterns to chunk types. This activates the entire confidence system (decay rates, type filtering, reinforcement) without needing `[confirmed]`/`[inferred]` tags in every file.

**Matching priority:**
1. Exact full path (`memory/2026-02-24.md`)
2. Exact basename (`MEMORY.md`)
3. Glob pattern — longest match wins (`memory/*.md`)

**Inline tags always override file defaults.** So a file defaulting to `fact` can still have individual `[confirmed]` or `[inferred]` chunks.

**Available types and their confidence values:**

| Type | Confidence | Decay behavior |
|------|-----------|----------------|
| `confirmed` | 1.0 | Immune to decay |
| `fact` | 1.0 | Normal decay |
| `decision` | 1.0 | Normal decay |
| `preference` | 1.0 | Normal decay |
| `opinion` | 0.8 | Normal decay |
| `inferred` | 0.7 | Normal decay |
| `outdated` | 0.3 | 2x faster decay |

## MCP tools (v4)

When running as an MCP server, exposes 5 tools:

| Tool | Purpose |
|------|---------|
| `sme_query` | Search memory with full-text search, type/confidence filters, time ranges |
| `sme_remember` | Save a fact/decision/preference to today's memory log (auto-indexed) |
| `sme_index` | Re-index workspace (use `force: true` for full rebuild) |
| `sme_reflect` | Run memory maintenance cycle (decay, reinforce, stale, contradictions, prune) |
| `sme_status` | Show index statistics |

The server auto-indexes on startup so the index is always fresh when Claude Code connects. Startup health is reported via `sme_status`.

## CLI commands

```bash
# Indexing
node lib/index.js index [--workspace PATH] [--force] [--include extra.md,other.md]

# Search
node lib/index.js query "terms" [--limit N] [--since 7d|2w|3m|1y|2026-01-01]
                                 [--context N] [--type fact|confirmed|inferred|...]
                                 [--min-confidence 0.5] [--include-stale] [--json]

# Status
node lib/index.js status [--workspace PATH] [--json]

# Memory maintenance
node lib/index.js reflect [--dry-run] [--workspace PATH]
node lib/index.js contradictions [--unresolved] [--limit N]
node lib/index.js archived [--limit N]
node lib/index.js restore <chunk-id>
```

### JSON output (`--json`)

Any command that returns data supports `--json` for machine-parseable output. This makes SME a universal memory backend — any runtime, bot, script, or agent can shell out and get structured data back.

```bash
# Structured search results
node lib/index.js query "aave health factor" --json
# → {"results":[{"filePath":"memory/2026-02-23.md","heading":"Aave V3 On-Chain Debt Integration","content":"...","score":-10.45,...}],"count":1}

# Index stats as JSON
node lib/index.js status --json
# → {"fileCount":22,"chunkCount":293,"files":[...]}
```

Pipe into `jq`, feed to a Telegram bot, call from a cron job, integrate with any AI agent — SME doesn't care what's on the other end.

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

## Query expansion (v4.2)

SME ships with ~60 built-in aliases covering crypto/DeFi, health, dev, personal, and finance domains. When an exact AND query returns nothing, it automatically falls back to OR-expanded queries using alias synonyms.

Example: searching "supplement" will also match "stack", "protocol", "nootropic".

Override or extend with `{workspace}/.memory/aliases.json`:

```json
{
  "job": ["work", "career", "employment"],
  "crypto": ["defi", "token", "chain", "wallet"]
}
```

Custom keys replace defaults per-key (not extend).

## Ranking

Results are scored by four factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| FTS5 BM25 | base | Keyword relevance |
| Recency | 1-2x | Linear decay over 90 days |
| File weight | 0.8-1.5x | MEMORY.md 1.5x, USER.md 1.3x, daily logs 1.0x |
| Confidence | 0-1x | `[confirmed]` ranks above `[outdated?]` |

## Index hygiene (v4.2.1)

SME keeps its index clean automatically:

- **Orphan cleanup** — when you delete a markdown file, the next index run detects it and removes the stale DB entries. No ghost results polluting your searches.
- **Write-path integrity** — `sme_remember` writes the fact, then immediately re-indexes just that file. If indexing fails, you get a visible warning instead of a silent black hole where your memory is saved but unsearchable.
- **Startup health** — `sme_status` reports whether the auto-index on MCP startup succeeded or failed, so you can diagnose issues without guessing.

## Design principles

1. **Markdown is source of truth** — the SQLite index is derived and fully rebuildable
2. **Additive only** — never modifies, deletes, or overwrites user files (except `sme_remember` which appends to daily logs)
3. **Offline-first** — no network, no API keys, no ongoing cost
4. **Single dependency** — just `better-sqlite3` + MCP SDK
5. **Archive, never delete** — pruned memories are recoverable via `restore`
6. **Self-cleaning** — orphan detection, write-path verification, startup health checks

## Testing

```bash
npm test  # 8 suites, 329 assertions
```

## License

MIT
