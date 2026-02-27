# Structured Memory Engine

Persistent, self-maintaining memory for AI agents. Indexes markdown files into a SQLite FTS5 database, extracts structured facts with confidence scoring, and runs its own memory lifecycle — decay, reinforcement, contradiction detection, and pruning. Exposes everything through an MCP server and a JSON-capable CLI. No API calls, no cloud, no ongoing cost. One dependency. Your AI remembers everything, forever.

## What it does

| Layer | Version | Purpose |
|-------|---------|---------|
| **Recall** | v1 | Full-text search over markdown files with ranked results and citations |
| **Retain** | v2 | Convention-based fact extraction with confidence scoring |
| **Reflect** | v3 | Memory lifecycle — decay, reinforcement, staleness, contradiction detection, pruning |
| **Reach** | v4 | MCP server for Claude Code — live search, write-path, config, file-level type defaults, JSON API |
| **Context** | v5 | Context Intelligence Layer — auto-retrieval, multi-signal ranking, token-budgeted injection, auto-capture |
| **Connect** | v5.2 | Entity graph, conversation context, optional semantic embeddings |
| **Ingest** | v5.3 | Transcript + CSV parsing, tagged markdown generation, auto-sync pipeline |

## Context Intelligence Layer (v5)

CIL turns SME from a searchable memory store into an auto-injection engine. Instead of the agent manually querying memory, CIL extracts terms from the current message, runs a multi-signal retrieval pipeline, and injects the most relevant facts directly into the system prompt.

**How it works:**

1. **Extract** — Pull key terms and entity names from the user's message + recent conversation
2. **Expand** — Entity graph adds co-occurring entities (mention "Jason" → also match "Avalon")
3. **Query** — Dual FTS5 search: AND query for precision, OR+aliases for recall
4. **Rank** — 6-signal scoring: FTS relevance + semantic similarity + recency + type priority + file weight + entity match, multiplied by confidence^1.5
5. **Budget** — Select top chunks within a token budget (default 1500), truncate if needed
6. **Inject** — Format as `## Recalled Context` block with source citations, confidence warnings, and contradiction flags

**Three ways to use it:**

| Method | How | Auto? |
|--------|-----|-------|
| **MCP tool** | Agent calls `sme_context` with the user's message | No — agent must be instructed |
| **Node API** | `engine.context('user message')` | No — caller invokes |
| **OpenClaw plugin** | `before_agent_start` hook injects automatically | Yes — zero config |

**Auto-recall** (OpenClaw plugin): Every agent turn, CIL reads the user's message, retrieves relevant memories, and prepends them to the system prompt. The agent just *knows* things without being asked to search. Enabled by default.

**Auto-capture** (OpenClaw plugin): After each agent turn, user messages are scanned for decisions, preferences, and facts. Matched content is automatically saved to the daily memory log. Max 3 captures per turn to avoid noise.

**For MCP-only users** (Claude Code, Cursor, etc.): Add this to your CLAUDE.md or system prompt:

```
Before responding to any user message, call sme_context with the user's message
to retrieve relevant memory. Incorporate the returned context silently.
```

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
  "owner": "Alex",
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
| `owner` | Personalizes MCP tool descriptions ("Search Alex's memory...") |
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
| `action_item` | 0.85 | Normal decay |
| `outdated` | 0.3 | 2x faster decay |

## MCP tools (v4+)

When running as an MCP server, exposes 9 tools:

| Tool | Purpose |
|------|---------|
| `sme_query` | Search memory with full-text search, type/confidence filters, time ranges |
| `sme_context` | Get relevant context for a message — ranked, budgeted, formatted for injection |
| `sme_remember` | Save a fact/decision/preference to today's memory log (auto-indexed) |
| `sme_index` | Re-index workspace (use `force: true` for full rebuild) |
| `sme_reflect` | Run memory maintenance cycle (decay, reinforce, stale, contradictions, prune, entity rebuild) |
| `sme_status` | Show index statistics |
| `sme_entities` | Query the entity graph — look up people, projects, co-occurring entities |
| `sme_embed` | Manage semantic embeddings — check status, build embeddings for all chunks |
| `sme_ingest` | Ingest meeting transcripts or CSV files — parse, tag, index |

The server auto-indexes on startup so the index is always fresh when Claude Code connects. Startup health is reported via `sme_status`.

## Entity Graph (v5.2)

SME tracks entity co-occurrences across all memory chunks. When "Jason" and "Avalon" appear in the same chunks repeatedly, SME knows they're related — even if a query only mentions one.

**How it works:** The entity index is rebuilt during every `reflect` cycle. It scans all chunk entity tags, builds co-occurrence counts, and stores them in a flat `entity_index` table for O(1) lookup.

**CIL integration:** When you query "What does Jason need?", CIL finds that Jason co-occurs with Avalon (2+ times), expands the entity set, and boosts Avalon-tagged chunks in results. You get related context you didn't explicitly ask for.

```bash
# List all known entities
sme entities

# Look up a specific entity
sme entities Jason

# CLI
node lib/index.js entities Jason
```

## Conversation Context (v5.2)

CIL supports multi-turn awareness. Pass the last 2-3 user messages as `conversationContext` and CIL extracts terms from them too — so "what about that?" after a question about bromantane will pull bromantane memories, not nothing.

```js
engine.context('what about that?', {
  conversationContext: ["How's the bromantane experiment going?"]
});
```

The `sme_context` MCP tool accepts `conversationContext` as an array parameter.

## Semantic Embeddings (v5.2, optional)

For conceptual similarity beyond keyword matching. Requires `@xenova/transformers` as an optional peer dependency.

```bash
npm install @xenova/transformers  # ~50MB, local model, no API calls
```

When installed, `sme_context` auto-computes a query embedding and scores chunks by cosine similarity against stored vectors. The ranking weights shift: FTS drops from 0.45 to 0.25, semantic similarity gets 0.25. When not installed, everything works exactly as before.

```bash
# Check embedding status
# via MCP: sme_embed with action: "status"

# Build embeddings for all chunks
# via MCP: sme_embed with action: "build"
```

Embeddings are stored as BLOB columns in the chunks table. Model: `Xenova/all-MiniLM-L6-v2` (384-dim, runs locally).

## Ingest Pipeline (v5.3)

SME can ingest structured data from meeting transcripts and CSV files. The pipeline parses source files, generates tagged markdown, writes to `{workspace}/ingest/`, and indexes via `indexSingleFile`. Markdown is the source of truth; the DB is derived.

```
Source files → Adapter (parse) → Tagged markdown → indexSingleFile → DB
```

### Transcripts

Parses speaker lines, tracks `currentSpeaker` across continuation lines, detects decisions and action items by keyword, and extracts attendees from `## Attendees` sections and speaker names.

```bash
# CLI
node lib/index.js ingest meeting-notes.txt --workspace ~/.claude

# Node API
engine.ingest('/path/to/meeting-notes.txt');

# MCP
# sme_ingest with sourcePath: "/path/to/meeting-notes.txt"
```

Output at `{workspace}/ingest/meeting-notes.md`:
```markdown
# Meeting Notes — meeting-notes.txt

## Summary
- [fact] Product review meeting covering Q1 roadmap priorities.

## Decisions
- [decision] We decided to go with REST over GraphQL (Speaker: Mike Chen)

## Action Items
- [action_item] Lisa Park will send the API spec to the backend team (Assigned: Lisa Park)

## Attendees
- Lisa Park, Mike Chen, Sarah Johnson
```

### CSV

State machine parser handling quoted fields, escaped quotes (`""`), newlines inside quotes, and ragged rows. Auto-detects headerless CSVs (all-numeric first row → generated `col_0, col_1, ...` headers).

```bash
node lib/index.js ingest data.csv --workspace ~/.claude
```

### Sync behavior

- **Manifest tracking** — `{workspace}/ingest/.sync-manifest.json` stores source mtime per file
- **Skip unchanged** — re-running ingest on the same file is a no-op unless `--force`
- **Directory batch** — pass a directory to ingest all `.txt`, `.md`, `.csv` files in one call
- **Auto-sync** — set `config.ingest.autoSync: true` + `config.ingest.sourceDir` to sync on MCP startup

### Config

Add to `{workspace}/.memory/config.json`:

```json
{
  "ingest": {
    "sourceDir": "/path/to/meeting-notes",
    "autoSync": true,
    "entityColumn": "Name"
  }
}
```

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

# Entity graph
node lib/index.js entities                     # list all entities
node lib/index.js entities Jason               # look up entity
node lib/index.js entities Jason --dry-run     # show related entities

# Context (CIL)
node lib/index.js context "What did we decide about lending?"

# Ingest
node lib/index.js ingest meeting.txt                    # single file
node lib/index.js ingest /path/to/sources/ --force      # directory, force re-sync
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

## Node.js API

Use SME as an importable module — no CLI, no MCP, no stdio. Three lines to a working memory engine.

```js
const sme = require('structured-memory-engine');
const engine = sme.create({ workspace: '/path/to/workspace' });

// Search memory
const results = engine.query('aave health factor', { limit: 5, type: 'confirmed' });

// Write a memory (immediately indexed and searchable)
engine.remember('decided to skip bromantane today', { tag: 'decision' });

// Re-index workspace files
const stats = engine.index({ force: false });

// Run memory maintenance cycle
const cycle = engine.reflect({ dryRun: true });

// Check index health
const status = engine.status();

// Restore an archived chunk
engine.restore(chunkId);

// Clean up when done
engine.close();
```

### `create(options)`

Returns an engine instance. Options:

| Option | Default | Description |
|--------|---------|-------------|
| `workspace` | `process.cwd()` | Path to workspace root (will create `.memory/` inside it) |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `query(text, opts)` | `Array` of ranked results | Search memory. Options: `limit`, `since`, `context`, `type`, `chunkType`, `minConfidence`, `includeStale` |
| `context(message, opts)` | `{ text, chunks, tokenEstimate }` | Get relevant context for injection. Options: `maxTokens`, `maxChunks`, `confidenceFloor`, `recencyBoostDays`, `flagContradictions`, `conversationContext`, `queryEmbedding` |
| `remember(content, opts)` | `{ filePath, created, line }` | Save to daily memory log and auto-index. Options: `tag` (`fact`/`decision`/`pref`/`opinion`/`confirmed`/`inferred`/`action_item`), `date` |
| `index(opts)` | `{ indexed, skipped, total, cleaned }` | Re-index workspace. Options: `force` |
| `reflect(opts)` | `{ decay, reinforce, stale, contradictions, prune, entityIndex }` | Run maintenance cycle + entity rebuild. Options: `dryRun` |
| `status()` | `{ fileCount, chunkCount, files }` | Index statistics |
| `restore(chunkId)` | `{ restored, newId?, error? }` | Restore archived chunk |
| `entities(name?)` | `Object` or `Array` | Get entity info by name, or list all entities |
| `relatedEntities(name)` | `Array` | Get co-occurring entities sorted by count |
| `buildEntities(opts)` | `{ entities, chunks }` | Rebuild entity index. Options: `dryRun` |
| `ingest(sourcePath, opts)` | `{ outputPath, indexed, skipped }` | Ingest a transcript or CSV file. Options: `force`, `type`, `entityColumn` |
| `parseTranscript(text, opts)` | `{ sections, speakers, decisions, actionItems, metadata }` | Parse transcript text without writing files |
| `parseCsv(text, opts)` | `{ headers, rows, metadata }` | Parse CSV text without writing files |
| `close()` | — | Close database handle |

All methods return raw data objects — no MCP formatting, no string wrapping. Integrate with anything.

## Fact tagging (v2)

Tag lines in your markdown for structured extraction:

```markdown
[fact] Takes bromantane 25mg sublingual daily
[decision] FTS5 over vector DB for search
[confirmed] Height is 6'5"
[inferred] Prefers warm lighting
[action_item] Send API spec to backend team by Friday
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

CIL scores chunks with 6 signals (weights shift when semantic embeddings are available):

| Signal | Without embeddings | With embeddings | Description |
|--------|-------------------|-----------------|-------------|
| FTS relevance | 0.45 | 0.25 | Keyword match via BM25 (normalized, 0.3 floor) |
| Semantic similarity | — | 0.25 | Cosine similarity against query embedding |
| Recency | 0.25 | 0.20 | Exponential decay (half-life = `recencyBoostDays`) |
| Type priority | 0.15 | 0.15 | `confirmed` +0.15, `decision` +0.12, ..., `outdated` -0.15 |
| File weight | 0.075 | 0.075 | MEMORY.md 1.5x, USER.md 1.3x, daily logs 1.0x |
| Entity match | 0.075 | 0.075 | Bonus when chunk entities overlap with query entities |

Final score = base × confidence^exponent. CIL uses exponent 1.5 (conf 0.6 → 0.465 multiplier, conf 0.3 → 0.164). `sme_query` uses the same shared scorer with a recall-tuned profile (linear confidence, 90-day recency half-life, heavier FTS weight).

## Index hygiene (v4.2.1)

SME keeps its index clean automatically:

- **Orphan cleanup** — when you delete a markdown file, the next index run detects it and removes the stale DB entries. No ghost results polluting your searches.
- **Write-path integrity** — `sme_remember` writes the fact, then immediately re-indexes just that file. If indexing fails, you get a visible warning instead of a silent black hole where your memory is saved but unsearchable.
- **Startup health** — `sme_status` reports whether the auto-index on MCP startup succeeded or failed, so you can diagnose issues without guessing.

## Design principles

1. **Markdown is source of truth** — the SQLite index is derived and fully rebuildable
2. **Additive only** — never modifies, deletes, or overwrites user files (except `sme_remember` which appends to daily logs)
3. **Offline-first** — no network, no API keys, no ongoing cost
4. **Minimal dependencies** — `better-sqlite3` + MCP SDK + zod
5. **Archive, never delete** — pruned memories are recoverable via `restore`
6. **Self-cleaning** — orphan detection, write-path verification, startup health checks

## OpenClaw Integration

SME ships with two integration paths for [OpenClaw](https://github.com/openclaw/openclaw):

### Path 1: Memory Plugin (drop-in replacement)

Replace `memory-core` with SME. One config change, instant upgrade.

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/Structured-Memory-Engine/extensions"] },
    "slots": { "memory": "memory-sme" }
  }
}
```

Registers `memory_search`, `memory_get`, `memory_remember`, `memory_reflect`. Auto-indexes on startup. CIL auto-recall and auto-capture are enabled by default.

**Plugin config options:**

```json
{
  "plugins": {
    "config": {
      "memory-sme": {
        "autoRecall": true,
        "autoRecallMaxTokens": 1500,
        "autoCapture": true,
        "captureMaxChars": 500
      }
    }
  }
}
```

See [extensions/memory-sme/README.md](extensions/memory-sme/README.md) for full setup.

### Path 2: Skill (try before you commit)

Install as a ClawHub skill for CLI-based access without replacing the memory slot:

```bash
export SME_PATH="/path/to/Structured-Memory-Engine"
export SME_WORKSPACE="$HOME/.openclaw/workspace"
```

See [skills/structured-memory-engine/SKILL.md](skills/structured-memory-engine/SKILL.md) for available commands.

## Testing

```bash
npm test  # 15 suites, 569 tests
```

## License

MIT
