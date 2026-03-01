# Structured Memory Engine

**Your AI agent forgets everything between sessions. SME fixes that.**

```bash
npm install structured-memory-engine
```

Persistent, self-maintaining memory that runs locally. No API calls, no cloud, no ongoing cost. **932 tests. <1ms recall. $0/month forever.**

<!-- TODO: Add demo GIF here -->
<!-- ![SME Demo](assets/demo.gif) -->

```js
const sme = require('structured-memory-engine').create({ workspace: '.' });
sme.index();
sme.context('What did Sarah say about the migration plan?');
// → Ranked, cited, confidence-scored context from 60+ meeting transcripts in <1ms
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
| **Contradiction Detection** | Smart detection with same-file exclusion, temporal awareness, and proximity checks | **Real contradictions, not false alarms** — 80%+ fewer false positives vs naive negation matching |
| **Contradiction Resolution** | CLI commands to resolve conflicts without editing source files | **One command fixes it** — `resolve 42 --action keep-newer` instead of hunting through markdown |
| **Configurable Decay** | Tunable half-life and decay rate per workspace | **Your workspace, your rules** — fast-moving projects decay in 90 days, core knowledge lives forever |
| **Memory Lifecycle** | Automatic decay, reinforcement, staleness detection, and pruning | **Self-cleaning index** — frequently-used memories get stronger, stale ones fade. Zero maintenance. |
| **Auto-Capture** | Detects decisions, preferences, and facts from conversation and saves them | **Never "remember to write it down" again** — 3 captures/turn, SHA-256 dedup, zero friction |
| **Transcript Ingestion** | Parses meeting recordings into tagged, searchable markdown | **60 meetings → searchable in one command.** Every decision, action item, and quote indexed. |
| **Token Budgeting** | Retrieves only what fits in a configurable token window | **No context overflow** — relevant memories in 1,500 tokens, not 50,000 |
| **Offline / Zero Cost** | SQLite FTS5 + local embeddings, no API calls | **$0/month forever.** No rate limits, no API keys, no vendor lock-in |
| **Query Intent Detection** | Classifies queries as action, reasoning, temporal, or factual — applies specialized scoring per type | **"What should I focus on?" pulls action items** — not random keyword matches |
| **Priority File Injection** | Action queries automatically surface open-loops and recent self-reviews regardless of keyword match | **Critical context never buried** — your todo list always surfaces when you ask for priorities |
| **Rule Chunk Penalty** | Detects policy/rule content and deprioritizes it for factual queries | **"What did I buy?" returns purchases** — not your Amazon account rules |
| **Forward-Looking Temporal** | "What's coming up in March?" searches for future events even when no files are dated in March | **Future planning works** — finds upcoming events, deadlines, and milestones |
| **Recall Test CLI** | Built-in test harness: `npm run test:recall` scores 6 standard queries with anti-term detection | **Regression-proof** — every change validated against real recall quality |

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

## Benchmarks

Measured on Apple M3 Max, 69GB RAM, Node v24.13.0. Run `npm run bench` to verify on your hardware.

| Operation | Dataset | Avg | p95 | Notes |
|-----------|---------|-----|-----|-------|
| Full index | 100 files → 500 chunks | 31ms | — | Cold start |
| Incremental reindex | 2/100 files changed | 2.2ms | — | mtime-based skip |
| Query (FTS5) | 10 queries, 500 chunks | 0.2ms | 0.2ms | Top 5 results |
| CIL context | 10 messages, 1500 tk budget | 0.3ms | 0.4ms | Full 6-step pipeline |
| Reflect cycle | 500 chunks | 3ms | — | All 5 phases |
| DB overhead | 100 files (100 KB src) | 368 KB | — | 3.7x source size |

CIL context is the critical path — it runs on every agent turn. At <1ms average, it adds negligible latency to any agent interaction.

## Quickstart (60 seconds)

### Option A: npm (recommended)

```bash
npm install structured-memory-engine
```

```js
const sme = require('structured-memory-engine').create({ workspace: '.' });
sme.index();                                          // Index your markdown files
sme.context('What did we decide about the API?');     // Get ranked context
sme.remember('Switching to PostgreSQL', { tag: 'decision' }); // Save a memory
```

### Option B: Clone + CLI

```bash
git clone https://github.com/Bryptobricks/Structured-Memory-Engine.git
cd Structured-Memory-Engine && npm install

# Index your workspace
sme index --workspace ~/your-workspace

# Search it
sme query "what did we decide" --workspace ~/your-workspace

# Get auto-formatted context for any message
sme context "What's the status on the API migration?"
```

### Option C: npx (zero install)

```bash
npx structured-memory-engine index --workspace ~/your-workspace
npx structured-memory-engine query "deployment timeline"
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

Replace the default memory backend in 3 steps:

**Step 1: Install extension dependencies**

```bash
cd extensions/memory-sme
npm install
npm link structured-memory-engine   # links to the parent package
```

> **Why?** The plugin runs in OpenClaw's process but needs to resolve `@sinclair/typebox` and `structured-memory-engine` from its own directory. The `npm link` creates a symlink to the parent SME package so `require('structured-memory-engine')` works.

**Step 2: Patch your OpenClaw config**

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/Structured-Memory-Engine/extensions"]
    },
    "slots": {
      "memory": "memory-sme"
    },
    "entries": {
      "memory-sme": {
        "enabled": true,
        "config": {
          "workspace": "/path/to/your/workspace",
          "autoRecall": true,
          "autoRecallMaxTokens": 2000,
          "autoCapture": true,
          "autoIndex": true
        }
      }
    }
  }
}
```

**Step 3: Restart OpenClaw**

```bash
openclaw gateway restart
```

Verify with `openclaw status` — you should see:
```
│ Memory │ enabled (plugin memory-sme) │
```

And in the logs:
```
memory-sme: indexed 51 files (51 total)
memory-sme: plugin registered (workspace: ..., autoRecall: true, autoCapture: true)
```

**What it does once installed:**
- **Auto-recall** injects relevant memories before every agent turn (you'll see `## Recalled Context` blocks)
- **Auto-capture** detects decisions, preferences, and facts from user messages and saves them
- **Auto-index** re-indexes your workspace on every gateway restart
- Replaces the built-in `memory_search`, `memory_remember`, and `memory_reflect` tools with SME-powered versions

**Troubleshooting:**
- `Cannot find module '@sinclair/typebox'` → Run `npm install` inside `extensions/memory-sme/`
- `Cannot find module 'structured-memory-engine'` → Run `npm link structured-memory-engine` inside `extensions/memory-sme/`
- `api.register is not a function` → You have an old version of the plugin. The plugin must export an **object** with a `register(api)` method, not a function.
- `Cannot read properties of undefined (reading 'trim')` → `registerService` needs an `id` field. Update to the latest plugin code.

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
| **Contradictions** | Smart detection with temporal awareness and proximity checks (see below) | Catch real contradictions, not just sequential updates |
| **Prune** | Very stale chunks archived (never deleted, always restorable via `restore`) | Index stays fast and lean. Nothing is ever permanently lost. |

Run it manually, on a cron, or as a Claude Code session hook. `--dry-run` to preview changes.

#### Configurable Decay

Most memory systems use fixed decay — everything fades at the same rate regardless of importance. SME lets you tune the curve:

```json
{
  "reflect": {
    "decayRate": 1.0,
    "halfLifeDays": 365
  }
}
```

- **`halfLifeDays`** — How many days until a memory's confidence halves. Default 365 (gentle decay). Set to 90 for fast-moving workspaces where last week matters more than last month.
- **`decayRate`** — Global multiplier on all decay. Set to 0.5 to halve all decay (memories last longer), or 2.0 to double it (aggressive cleanup). Set to 0 to disable decay entirely.

`confirmed` chunks are always immune to decay regardless of settings. This means your core identity files (CLAUDE.md, USER.md) never fade.

#### Smart Contradiction Detection

Naive contradiction detection flags any two chunks that share keywords and contain negation words. This produces false positives constantly — "WHOOP band removed" and "WHOOP band shipping" aren't contradictions, they're sequential events.

SME's contradiction engine has three layers of filtering that eliminate false positives while catching real conflicts:

| Filter | What it does | Why it matters |
|--------|-------------|----------------|
| **Same-file exclusion** | Chunks from the same file are never flagged | Sections within one document don't contradict each other — they're context for each other |
| **Temporal awareness** | If negation only appears in the newer dated file, it's treated as an update, not a conflict | "Started protocol" → "Stopped protocol" is progression, not contradiction |
| **Proximity check** | Negation must appear within 8 words of a shared term to count | "not" in an unrelated sentence doesn't make two chunks contradictory |

Enable the advanced filters in config:

```json
{
  "reflect": {
    "contradictionMinSharedTerms": 4,
    "contradictionTemporalAwareness": true,
    "contradictionRequireProximity": true
  }
}
```

Same-file exclusion is always on (no config needed). Temporal awareness and proximity are opt-in because they change detection behavior — enable them once you've seen the baseline.

#### Resolving Contradictions

When contradictions are flagged, resolve them from the CLI instead of manually editing files:

```bash
# List unresolved contradictions
node lib/index.js contradictions --unresolved

# Keep the newer chunk, downgrade the older one to outdated (confidence → 0.3)
node lib/index.js resolve 42 --action keep-newer

# Keep both — dismiss the flag without changing anything
node lib/index.js resolve 42 --action keep-both

# Other options: keep-older, dismiss
```

**Why this matters:** Other systems force you to manually edit source files to fix contradictions. SME resolves them at the index level — the outdated chunk gets deprioritized in ranking without touching your markdown. Your files stay untouched, and the conflict is resolved in one command.

#### Auto-Reflect on Index

Run reflect automatically after every reindex — zero maintenance:

```json
{
  "reflect": {
    "autoReflectOnIndex": true
  }
}
```

This adds ~3ms to each index run. The reflect cycle handles decay, reinforcement, contradiction detection, and pruning in one pass. Combined with auto-index on agent startup, your memory stays healthy without ever running a manual command.

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
  },
  "reflect": {
    "decayRate": 1.0,
    "halfLifeDays": 365,
    "contradictionMinSharedTerms": 4,
    "contradictionRequireProximity": true,
    "contradictionTemporalAwareness": true,
    "autoReflectOnIndex": false
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
sme resolve <contradiction-id> --action keep-newer|keep-older|keep-both|dismiss
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
npm test  # 18 suites, 932 tests
```

## License

MIT
