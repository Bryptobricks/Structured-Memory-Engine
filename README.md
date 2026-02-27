# Structured Memory Engine

**Your AI agent forgets everything between sessions. SME fixes that.**

Persistent, self-maintaining memory that runs locally. No API calls, no cloud, no ongoing cost. Three lines of code and your agent remembers everything — decisions, preferences, people, context — forever.

```js
const engine = require('structured-memory-engine').create({ workspace: '.' });
engine.index();
engine.context('What did Sarah say about the migration plan?');
// → Returns ranked, cited, confidence-scored context from 60+ meeting transcripts
```

## The Problem

AI agents have amnesia. Every session starts from zero. Your agent doesn't remember what you decided yesterday, who you talked to last week, or what matters most to you. The workarounds — stuffing everything into system prompts, manually searching files, hoping the context window holds — don't scale.

## What SME Does About It

| Capability | What it does | Tangible benefit |
|-----------|-------------|-----------------|
| **Auto-Recall** | Injects relevant memories into every agent turn automatically | **Zero manual searching** — agent just *knows* things without being asked |
| **Confidence Scoring** | Tags facts as confirmed, inferred, or outdated with decay over time | **No more stale info served confidently** — outdated facts are deprioritized 6x vs confirmed |
| **Entity Graph** | Tracks relationships between people, projects, and topics | **Ask about "Sarah" → also get "Nexus" context** — 40-60% more relevant results on entity-heavy queries |
| **6-Signal Ranking** | Scores results by keyword match + recency + confidence + type + file weight + entity overlap | **Top result is the right result** — not just the one with the most keyword hits |
| **Contradiction Detection** | Flags when your memory contains conflicting facts | **Catch when old info contradicts new decisions** before acting on bad data |
| **Memory Lifecycle** | Automatic decay, reinforcement, staleness detection, and pruning | **Self-cleaning index** — frequently-used memories get stronger, stale ones fade. Zero maintenance. |
| **Auto-Capture** | Detects decisions, preferences, and facts from conversation and saves them | **Never "remember to write it down" again** — 3 captures/turn, zero friction |
| **Transcript Ingestion** | Parses meeting recordings into tagged, searchable markdown | **60 meetings → searchable in one command.** Every decision, action item, and quote indexed. |
| **Token Budgeting** | Retrieves only what fits in a configurable token window | **No context overflow** — relevant memories in 1,500 tokens, not 50,000 |
| **Offline / Zero Cost** | SQLite FTS5 + local embeddings, no API calls | **$0/month forever.** No rate limits, no API keys, no vendor lock-in |

## Before & After

**Without SME:**
```
User: "What did we decide about the database migration?"
Agent: "I don't have context on that. Could you remind me?"
```

**With SME (auto-recall):**
```
User: "What did we decide about the database migration?"

## Recalled Context (auto-injected, 3 chunks, 847 tokens)
- [decision] Going with PostgreSQL on AWS for the main database. Sarah confirmed parameters.
  Source: memory/2026-02-20.md:45 | confidence: 1.0
- [fact] Target connection pool size 50, failover monitoring via CloudWatch alerts
  Source: memory/2026-02-21.md:23 | confidence: 0.95
- [action_item] Sarah to send final migration runbook by Friday
  Source: ingest/nexus-standup-feb19.md:112 | confidence: 0.85

Agent: "We decided on PostgreSQL on AWS. Sarah confirmed the parameters — pool size 50 with
        CloudWatch failover monitoring. She owes us the final migration runbook by Friday."
```

**The difference:** The agent answered with specifics, citations, and confidence levels — without being asked to search. That context was auto-injected before the agent even started thinking.

## How It Works

Every time your agent receives a message, SME runs a 6-step pipeline in <50ms:

1. **Extract** — Key terms and entity names from the user's message + recent conversation
2. **Expand** — Entity graph adds related entities (mention "Sarah" → also match "Nexus")
3. **Query** — Dual FTS5 search: AND query for precision, OR query with alias expansion for recall
4. **Rank** — 6-signal scoring: keyword relevance + semantic similarity + recency + type priority + file weight + entity overlap, multiplied by confidence^1.5
5. **Budget** — Top chunks selected within a token limit (default 1,500), cleanly truncated
6. **Inject** — Formatted as cited context with confidence warnings and contradiction flags

Markdown files are always the source of truth. The SQLite index is derived and fully rebuildable. SME never modifies your files.

## Quickstart (60 seconds)

```bash
git clone https://github.com/chainseeker44/Structured-Memory-Engine.git
cd Structured-Memory-Engine && npm install

# Index your workspace
node lib/index.js index --workspace ~/your-workspace

# Search it
node lib/index.js query "what did we decide" --workspace ~/your-workspace

# Get auto-formatted context for any message
node lib/index.js context "What's the status on the API migration?"
```

That's it. Your markdown files are now a searchable, ranked, confidence-scored memory system.

## Integration Options

SME works everywhere. Pick the path that fits your setup:

### Claude Code / Cursor (MCP Server)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "sme": {
      "command": "node",
      "args": ["/path/to/Structured-Memory-Engine/lib/mcp-server.js"],
      "env": { "SME_WORKSPACE": "/path/to/workspace" }
    }
  }
}
```

Exposes 9 tools: `sme_query`, `sme_context`, `sme_remember`, `sme_index`, `sme_reflect`, `sme_status`, `sme_entities`, `sme_embed`, `sme_ingest`.

**Pro tip:** Add this to your CLAUDE.md for automatic memory recall:
```
Before responding to any user message, call sme_context with the user's message
to retrieve relevant memory. Incorporate the returned context silently.
```

### OpenClaw (Drop-In Plugin)

Replace the default memory backend. One config change:

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/Structured-Memory-Engine/extensions"] },
    "slots": { "memory": "memory-sme" },
    "config": {
      "memory-sme": {
        "autoRecall": true,
        "autoRecallMaxTokens": 1500,
        "autoCapture": true
      }
    }
  }
}
```

Auto-recall and auto-capture are enabled by default. Your agent gets persistent memory with zero code changes.

### Node.js API (Embed Anywhere)

```js
const engine = require('structured-memory-engine').create({ workspace: '.' });

engine.query('database connection pooling', { limit: 5, type: 'confirmed' });
engine.remember('decided to use Redis for caching', { tag: 'decision' });
engine.context('What did Sarah say?', { maxTokens: 2000 });
engine.reflect({ dryRun: true });
engine.ingest('/path/to/meeting-transcript.txt');
engine.close();
```

### CLI (Scripts, Cron Jobs, Pipelines)

Every command supports `--json` for machine-parseable output. Pipe into `jq`, call from cron, feed to any agent.

```bash
node lib/index.js query "deployment timeline" --json --limit 5
node lib/index.js reflect --dry-run
node lib/index.js ingest /path/to/meetings/ --force
node lib/index.js entities Sarah
```

## Features Deep Dive

### Fact Tagging

Tag lines in your markdown for structured extraction:

```markdown
[fact] Team standup is at 9am Pacific daily
[decision] FTS5 over vector DB for search
[confirmed] Default deploy target is us-east-1
[inferred] Prefers dark mode
[action_item] Send API spec to backend team by Friday
[outdated?] Redis cache TTL was 300s (now 600s)
```

Untagged bullets under headings like `## Decisions`, `## Facts`, `## Preferences` are auto-classified. No tagging required to get value — it just makes results more precise.

### Memory Lifecycle

The `reflect` command runs a full maintenance cycle:

| Phase | What happens | Why it matters |
|-------|-------------|----------------|
| **Decay** | Confidence decreases over time. `confirmed` is immune. `outdated` decays 2x faster. | Old unverified info naturally fades instead of competing with fresh facts |
| **Reinforce** | Frequently-searched chunks get a confidence boost (capped at 1.0) | Your most-used memories get stronger — the system learns what matters |
| **Stale** | Low confidence + old age → marked stale, excluded from search by default | No more irrelevant results from months-old notes cluttering your context |
| **Contradictions** | Same-heading chunks with negation signals are flagged | Catch "we decided X" vs "actually we're going with Y" before it causes problems |
| **Prune** | Very stale chunks archived (never deleted, always restorable via `restore`) | Index stays fast and lean. Nothing is ever permanently lost. |

Run it manually, on a cron, or as a Claude Code session hook. `--dry-run` to preview changes.

### Entity Graph

SME tracks entity co-occurrences across all memory. When "Sarah" and "Nexus" appear in the same chunks repeatedly, they're linked — even if a query only mentions one.

```bash
node lib/index.js entities Sarah
# → Sarah: 12 mentions, co-occurs with Nexus (8), migration (5), backend (4)
```

**CIL integration:** Query "What does Sarah need?" → CIL expands to also search Nexus-tagged chunks. You get related context you didn't explicitly ask for.

### Transcript & CSV Ingestion

Turn unstructured meeting recordings and data files into tagged, searchable memory:

```bash
# Single transcript
node lib/index.js ingest meeting-notes.txt

# Batch a whole directory
node lib/index.js ingest /path/to/meetings/

# CSV data
node lib/index.js ingest portfolio-data.csv
```

**Transcripts** → Extracts speakers, decisions, action items, attendees. Tags everything.
**CSV** → State machine parser handles quoted fields, escaped quotes, newlines in quotes, ragged rows.
**Sync** → Manifest-based. Re-running is a no-op unless source files changed or `--force` is used.

### Semantic Embeddings (Optional)

For conceptual similarity beyond keyword matching:

```bash
npm install @xenova/transformers  # ~50MB, local model, no API calls
```

When installed, ranking shifts: FTS drops from 0.45 to 0.25 weight, semantic similarity gets 0.25. Finds conceptually related memories even without keyword overlap. When not installed, everything works exactly as before.

Model: `Xenova/all-MiniLM-L6-v2` (384-dim, runs locally on CPU/GPU).

### Query Expansion

Ships with ~60 built-in aliases: searching "supplement" also matches "stack", "protocol", "nootropic". Covers crypto/DeFi, health, dev, personal, and finance domains.

Override with `{workspace}/.memory/aliases.json`:
```json
{
  "job": ["work", "career", "employment"],
  "crypto": ["defi", "token", "chain", "wallet"]
}
```

## Ranking

CIL scores every chunk with 6 signals:

| Signal | Without embeddings | With embeddings | Description |
|--------|-------------------|-----------------|-------------|
| FTS relevance | 0.45 | 0.25 | Keyword match via BM25 (normalized, 0.3 floor) |
| Semantic similarity | — | 0.25 | Cosine similarity against query embedding |
| Recency | 0.25 | 0.20 | Exponential decay (half-life = `recencyBoostDays`) |
| Type priority | 0.15 | 0.15 | `confirmed` +0.15 ... `outdated` -0.15 |
| File weight | 0.075 | 0.075 | MEMORY.md 1.5x, USER.md 1.3x, daily logs 1.0x |
| Entity match | 0.075 | 0.075 | Bonus when chunk entities overlap with query |

Final score = base × confidence^1.5. A chunk with confidence 0.6 gets a 0.46x multiplier. Confidence 0.3 → 0.16x. **High-confidence memories dominate. Low-confidence noise fades.**

## Configuration

Config lives at `{workspace}/.memory/config.json`. All fields optional:

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
  },
  "ingest": {
    "sourceDir": "/path/to/meeting-notes",
    "autoSync": true
  }
}
```

### File-Level Type Defaults

Map file patterns to chunk types. This activates the confidence system without needing inline tags:

| Type | Confidence | Decay | Use for |
|------|-----------|-------|---------|
| `confirmed` | 1.0 | Immune | Core facts, identity, verified info |
| `fact` | 1.0 | Normal | Daily logs, general notes |
| `decision` | 1.0 | Normal | Choices made, commitments |
| `preference` | 1.0 | Normal | Likes, dislikes, habits |
| `opinion` | 0.8 | Normal | Beliefs, takes, assessments |
| `action_item` | 0.85 | Normal | Tasks, deadlines, assignments |
| `inferred` | 0.7 | Normal | Guesses, assumptions |
| `outdated` | 0.3 | 2x faster | Superseded info |

**Matching priority:** exact path > basename > glob (longest wins). Inline tags always override file defaults.

## Session Hooks (Claude Code)

Auto-index on session start, reflect on session end:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node /path/to/sme/bin/sme-hook.js index" }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node /path/to/sme/bin/sme-hook.js reflect" }]
    }]
  }
}
```

## Architecture

SME is built in layers. Each layer is independently useful:

| Layer | Name | What it adds |
|-------|------|-------------|
| v1 | **Recall** | Full-text search over markdown with BM25 ranking and citations |
| v2 | **Retain** | Fact extraction with confidence scoring and type classification |
| v3 | **Reflect** | Memory lifecycle — decay, reinforcement, contradiction detection, pruning |
| v4 | **Reach** | MCP server, write-path (`remember`), config system, JSON API |
| v5 | **Context** | Auto-retrieval pipeline — the CIL engine that makes everything automatic |
| v5.2 | **Connect** | Entity graph, conversation context, optional semantic embeddings |
| v5.3 | **Ingest** | Transcript + CSV parsing with auto-sync pipeline |

## API Reference

### Node.js

| Method | Returns | Description |
|--------|---------|-------------|
| `query(text, opts)` | `Array` | Search memory. Opts: `limit`, `since`, `context`, `type`, `minConfidence`, `includeStale` |
| `context(message, opts)` | `{ text, chunks, tokenEstimate }` | Auto-retrieval for injection. Opts: `maxTokens`, `maxChunks`, `confidenceFloor`, `conversationContext` |
| `remember(content, opts)` | `{ filePath, created, line }` | Save to daily log + auto-index. Opts: `tag`, `date` |
| `index(opts)` | `{ indexed, skipped, total, cleaned }` | Re-index workspace. Opts: `force` |
| `reflect(opts)` | `{ decay, reinforce, stale, contradictions, prune }` | Run maintenance cycle. Opts: `dryRun` |
| `status()` | `{ fileCount, chunkCount, files }` | Index statistics |
| `restore(chunkId)` | `{ restored, newId? }` | Recover archived chunk |
| `entities(name?)` | `Object \| Array` | Entity lookup or list all |
| `ingest(path, opts)` | `{ outputPath, indexed, skipped }` | Ingest transcript/CSV. Opts: `force`, `type` |
| `close()` | — | Close database handle |

### MCP Tools

| Tool | Purpose |
|------|---------|
| `sme_query` | Search with filters (type, confidence, time range) |
| `sme_context` | Get ranked, budgeted context for any message |
| `sme_remember` | Save a tagged memory (auto-indexed) |
| `sme_index` | Re-index workspace |
| `sme_reflect` | Run maintenance cycle |
| `sme_status` | Index health and statistics |
| `sme_entities` | Query the entity graph |
| `sme_embed` | Manage semantic embeddings |
| `sme_ingest` | Ingest transcripts or CSV files |

### CLI

```bash
sme index [--workspace PATH] [--force]
sme query "search terms" [--limit N] [--since 7d] [--type fact] [--json]
sme context "user message" [--max-tokens 1500]
sme reflect [--dry-run]
sme status [--json]
sme entities [name]
sme ingest <file-or-dir> [--force]
sme contradictions [--unresolved]
sme archived [--limit N]
sme restore <chunk-id>
```

## Design Principles

1. **Markdown is source of truth** — SQLite index is derived and rebuildable
2. **Additive only** — never modifies or deletes user files
3. **Offline-first** — no network, no API keys, no ongoing cost
4. **Minimal dependencies** — `better-sqlite3` + `@modelcontextprotocol/sdk` + `zod`
5. **Archive, never delete** — pruned memories are always restorable
6. **Self-cleaning** — orphan detection, write-path verification, startup health checks

## Testing

```bash
npm test  # 15 suites, 569 tests
```

## License

MIT
