# Roadmap

## v1 — Recall (current)
Search-only layer over existing markdown memory files. No writes, no modifications.

- SQLite FTS5 index derived from markdown files
- Chunking by heading with paragraph overflow splitting
- Composite ranking: BM25 × recency boost × file weight
- Query expansion with OR fallback + configurable alias map
- Context windowing (adjacent chunks around results)
- Incremental reindex (mtime-based)
- Fully read-only — never touches source markdown files

**Status:** Complete

---

## v2 — Retain (shipped)
Convention-based fact extraction from tagged markdown. Zero LLM calls, zero cost.

### Shipped:
- Tag-based extraction: `[fact]`, `[decision]`, `[pref]`, `[opinion]`, `[confirmed]`, `[inferred]`, `[outdated?]`
- Heading-based bullet classification (substring matching: `## Key Decisions`, `## What I Learned`, etc.)
- Confidence mapping: `[confirmed]`→1.0, `[inferred]`→0.7, `[outdated?]`→0.3
- Distinct type storage: confirmed/inferred/outdated stored as separate types (queryable independently)
- Query filters: `--type` and `--min-confidence`
- Confidence-weighted ranking in composite score

### Future (v2.x):
- Entity tables (name, type, first_seen, last_seen, summary) + junction table
- Richer entity extraction: people, dates, amounts, addresses, URLs
- Deduplication across daily logs and curated files
- One-time Haiku backfill for historical untagged files (Option C)

---

## v3 — Reflect (shipped)
Memory lifecycle management. Rule-based, zero LLM calls, zero ongoing cost.

### Shipped:
- Confidence decay — time-based decay with type-specific rates (`confirmed` immune, `outdated` 2x faster)
- Access-based reinforcement — frequently-accessed chunks get confidence boost (capped at 1.0)
- Staleness detection — low confidence + old age → marked stale, excluded from search by default
- Contradiction detection — same heading + shared terms + negation signal → flagged
- Archival pruning — stale + very low confidence → moved to `archived_chunks` (never deleted)
- Restore command — recover any archived chunk back to active index
- Access tracking activated — `access_count` + `last_accessed` updated on every search hit
- Column-specific FTS trigger — prevents index churn on metadata-only updates
- Dry-run mode — preview all changes without modifying database
- `--include-stale` flag for search — opt-in to see stale results

### Future (v3.x):
- Scheduled reflection jobs (cron/daily)
- Entity page generation — auto-maintain summary pages per entity
- Opinion evolution — track confidence over time with evidence links
- Core memory promotion — surface frequently-accessed facts for always-loaded context

---

## v4 — Reach
MCP server for Claude Code. First write-path (sme_remember).

### v4.0 (shipped):
- MCP stdio server with 6 tools: sme_query, sme_context, sme_remember, sme_index, sme_reflect, sme_status
- New remember module — write tagged facts to daily memory logs
- Auto-reindex after remember (mtime-based, only changed file reindexed)
- Workspace configurable via SME_WORKSPACE env var

### v4.1 — Config + Wider Discovery + Hooks (shipped):
- Config file (`{workspace}/.memory/config.json`) — owner name, explicit includes, glob patterns
- Wider file discovery — CLAUDE.md, agents/*.md, skills/*.md, plans/*.md now indexable via config
- Auto-index on MCP server startup — index is fresh when Claude Code connects
- One-shot hook script (`bin/sme-hook.js`) — `index` and `reflect` commands for session lifecycle hooks
- Owner-personalized tool descriptions — `config.owner` drives "Search {owner}'s memory..." vs generic
- Zero changes to core modules (store, indexer, recall, retain, reflect)

### v4.2 — File-Level Type Defaults + Alias Expansion (shipped):
- File-level type defaults via `config.fileTypeDefaults` — map file patterns to chunk types (e.g. `MEMORY.md → confirmed`, `memory/*.md → fact`)
- Priority: exact path > basename > glob pattern (longest wins). Inline tags still override file defaults.
- `resolveFileType()` in config.js — shared by indexer.js and mcp-server.js
- Expanded DEFAULT_ALIASES in recall.js — ~60 entries covering crypto/DeFi, health, dev, personal, finance
- Threaded through all indexing paths: `indexWorkspace()`, `indexSingleFile()`, MCP auto-index, `handleRemember()`

### Future (v4.x):
- sme_contradictions tool

---

## v5 — Context Intelligence Layer
Auto-retrieval pipeline: extract terms → dual FTS5 search → multi-signal ranking → token budgeting → formatted injection.

### v5.0 (shipped):
- CIL core: extractQueryTerms → AND+OR dual query → cilScore (5-signal weighted) → budgetChunks → formatContext
- sme_context MCP tool — auto-retrieval for Claude Code
- Entity-match bonus in scoring — known entities from chunks boost relevance
- Contradiction flagging in context output

### v5.1 (shipped):
- OpenClaw plugin auto-recall: `before_agent_start` hook injects context automatically
- OpenClaw plugin auto-capture: scans user messages for decisions/preferences/facts, saves to daily log
- Plugin config: autoRecall, autoRecallMaxTokens, autoCapture, captureMaxChars

### v5.2 (shipped):
- Entity graph with co-occurrence tracking (sme_entities tool)
- Conversation context — multi-turn awareness via recent message terms
- Semantic embeddings — optional @xenova/transformers, cosine similarity in CIL scoring
- sme_embed tool — status + build commands for embedding management

### v5.2.1 — Hardening (shipped):
- Fix: CIL pipeline no longer inflates access_count (skipTracking flag on search)
- Consolidated scoring — single scorer in lib/scoring.js with weight profiles (RECALL, CIL, CIL_SEMANTIC)
- Input validation at MCP boundary — max length constraints on all string inputs
- 48 new unit tests for scoring, CIL functions, skipTracking, entity cache
- 14 test suites, 520 tests total

### v5.3 — Ingest Pipeline (shipped):
- Transcript parser — speaker tracking, decision/action-item detection, section-aware extraction
- CSV parser — state machine (handles quoted fields, escaped quotes, newlines in quotes, ragged rows)
- Sync runner — parse → tagged markdown → indexSingleFile, mtime-based skip via manifest
- New `action_item` tag type — confidence 0.85, supported in retain, remember, scoring
- `sme_ingest` MCP tool — ingest meeting transcripts and CSV files
- `ingest` CLI command — single file or directory batch sync
- Node API: `ingest()`, `parseTranscript()`, `parseCsv()` methods
- Auto-sync on MCP startup via `config.ingest.autoSync`
- `ingest/` directory auto-discovered by indexer

### Future (v5.x):
- Scheduled reflection jobs (cron/daily)
- Core memory promotion — surface frequently-accessed facts for always-loaded context

---

## Design principles (all versions)

1. **Markdown is always source of truth** — the SQLite index is derived and rebuildable
2. **Additive only** — never modifies, deletes, or overwrites existing user files
3. **Offline-first** — works without network; cloud APIs are optional enhancements
4. **Seamless integration** — layers on top of any OpenClaw workspace without configuration
5. **Forward-compatible schema** — migrations are additive and non-destructive
