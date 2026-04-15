# Changelog

All notable changes to Structured Memory Engine will be documented in this file.

## [10.0.0] - 2026-04-14

Competitive response release. Closes the four gaps identified in the myapp Active Memory / Dreaming / memory-wiki / memory-lancedb analysis without inheriting their architectural debt: no blocking LLM in the hot path, no heartbeat cron, no 220-char output ceiling, no five-layer fragmentation. Five new features all ship behind deterministic, inspectable, zero-cost machinery.

### Added

**F1 — Recall Strategy Orchestrator** (`lib/orchestrator.js`)
- Deterministic query classifier (pure regex + entity detection, zero LLM) picks per-strategy scoring profiles before recall executes.
- Four strategies: `entity_brief`, `timeline_brief`, `relationship_brief`, `verification_lookup`. `quick_context` is the fallback.
- Eight new scoring profiles registered in `lib/scoring.js` (4 strategies × base/semantic).
- Priority order: `verification_lookup → timeline_brief → relationship_brief → entity_brief → quick_context`.
- Wired into `recall.js` and `context.js` — explicit `recallProfile` still wins.
- New `sme query --explain` flag reports classified strategy, reason, weights, half-life, and detected entities.

**F2 — Memory Tiering + Recall-Stat Auto-Promotion** (`lib/memory-tier.js`)
- Four-tier classification at ingest: `durable_personal` (1.0x), `durable_project` (1.0x), `working_reference` (0.75x), `ops_runbook` (0.45x).
- Fast path from `chunk_type` (preference/confirmed → personal; decision/action_item → project). Content regex for everything else.
- Tier multiplier applied as the final structural factor in `scoring.js::score` (after metadata penalty).
- Inline promotion in `recall.js::recordRecallStats` — ops→working at 10/5, working→durable at 5/3 (recall_count / unique_query_count). SHA-1 prefix query hashing, capped at 50 distinct queries per chunk. No background process, no heartbeat.
- Schema: `memory_tier`, `recall_count`, `unique_query_count`, `query_hash_seen`, `idx_chunks_tier`.

**F3 — Recall Gate + Auto-Inject CIL Mode** (`lib/recall-gate.js`, `sme_auto_context` MCP tool)
- Pure-regex classifier that skips the CIL pipeline entirely for acknowledgments, math expressions, system commands, and too-short messages. Zero DB access for gated messages.
- New `sme_auto_context` MCP tool designed as a drop-in turn-start hook. Gated messages short-circuit without cost; substantive messages get full ranked chunk injection. Replaces myapp's 842ms Active Memory Plugin pattern with a 0ms gate + sub-ms CIL.
- Config: `recallGating { enabled, minMessageLength }` and `autoInject { enabled, maxTokens }`, both on by default.
- Existing `sme_context` unchanged (explicit calls bypass the gate).

**F4 — Memory Actions** (`lib/memory-actions.js`, `sme_memory_action` MCP tool)
- First-class mutation API: `update` (in-place rewrite preserving id + created_at), `replace` (archive old + insert new, with `superseded_by` tracking), `forget` (soft-delete: confidence=0 + archived_at), `protect` (exempts from reflect decay/pruning).
- Target resolution: numeric id → direct lookup; query string → deterministic recall with 0.7 minConfidence threshold; top 2 within 0.08 score delta raises `AmbiguousTargetError` with candidate review list.
- Schema: `protected`, `superseded_by`, `archived_at`.
- `reflect.js` `decayConfidence`, `markStale`, `pruneStale` all honor the `protected` flag.
- CLI: `sme forget/update/replace/protect <id|query>`.

**F5 — Entity Mention Scoring** (`lib/scoring.js::entityMentionScore`)
- Wires latent `entity_index.mention_count` + `co_entities` into the scoring pipeline as a log-scaled boost signal plus a per-pair co-occurrence bonus.
- New helpers in `lib/entities.js`: `extractQueryEntities(db, query)` and `getEntityIndexMap(db, names)` for batch lookup.
- Default weight 0 in existing profiles (no regression). `entity_brief` and `relationship_brief` strategies set `entityMention: 0.25` and use the signal as a primary ranker.

### Benchmarks
- Query latency unchanged at ~0.6ms avg (FTS5, 419 chunks) — new signals and tiering did not regress the critical path.
- CIL context unchanged at ~1.4ms avg (10-msg, 1500-token budget).
- 23 test suites, 1298+ assertions, 0 failures.

### Migration notes
- All schema changes are additive `ALTER TABLE ADD COLUMN` via `openDb()`. Existing v7.3.0 databases auto-upgrade on first open.
- Existing chunks without a `memory_tier` value get the `working_reference` default. Run `sme index --rebuild` to backfill exact tiers via ingest-time classification.
- No breaking changes to APIs, CLI, or config.

## [7.3.0] - 2026-04-14

### Added
- **Metadata-noise filter** (`lib/noise.js`): new `metadataDensityPenalty()` and `isMetadataHeavy()` detect chunks dominated by operational metadata (session IDs, token counts, YAML frontmatter, code-block envelopes, "Conversation info" blocks).
- Three-stage filtering:
  1. **Indexing** — metadata-heavy chunks skipped at chunk time (`lib/indexer.js`)
  2. **Retrieval** — metadata-heavy rows filtered post-FTS (`lib/retrieve.js`)
  3. **Scoring** — surviving metadata penalized via final-score multiplier (`lib/scoring.js`)
- Config flag `filterMetadataNoise` (default `true`) threaded through recall/context/index/remember paths.
- `getChunksByExactFile(db, filePath)` in `lib/store.js` — exact file-path match for priority file injection; prevents substring false positives (e.g. `archive-open-loops.md` no longer matches `open-loops.md` injection).
- Extensions: `extensions/memory-sme/index.ts` now falls back to repo-root require when the npm package isn't resolvable.

### Tests
- 6 new tests covering: config default, disable flag, exact file matching, metadata chunk dropping at index time, retrieval filtering, scoring penalty application.

## [7.0.0] - 2026-03-03

### Changed
- **Heading-Aware Embeddings**: Embeddings now include section headings, not just body content
  - Queries like "supplements" now match chunks under "Current Supplements & Stack" heading
  - Improves semantic recall for ALL chunks, especially those with keyword-sparse body text
  - Headings become part of the semantic fingerprint

### Added
- `clearEmbeddings(db)` function to reset all embeddings for re-computation
  - Use after upgrading to v7.0 to re-embed with heading context
  - Run `sme embed --force` after upgrading

### Upgrade Notes
To take advantage of heading-aware embeddings, existing users should:
1. Upgrade to v7.0.0: `npm update structured-memory-engine`
2. Clear and re-compute embeddings: `sme embed --force` (or programmatically via `clearEmbeddings()` + `embedAll()`)

## [6.10.2] - 2026-03-02
- Refactored retrieval pipeline into `lib/retrieve.js`
- Bug fixes for recall ordering, FTS normalization, self-reference penalty

## [6.10.1] - 2026-03-02
- Added `sme init` command for zero-friction workspace scaffolding
- README improvements and quick-start section

## [6.10.0] - 2026-03-02
- Semantic embeddings integration (optional @xenova/transformers)
- Temporal + intent + rule-penalty scoring system
- 1,000+ test assertions
