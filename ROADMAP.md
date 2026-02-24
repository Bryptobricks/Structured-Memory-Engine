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

## v3 — Reflect (planned)
Periodic synthesis and belief management. The system reviews its own knowledge and evolves.

- Scheduled reflection jobs (daily or weekly)
- Entity page generation — auto-maintain summary pages per entity (people, projects, protocols)
- Opinion evolution — track confidence over time with evidence links (supporting + contradicting facts)
- Contradiction detection — flag when new facts conflict with existing beliefs
- Staleness decay — reduce confidence on facts that haven't been reinforced
- Pruning — archive superseded facts, compress redundant entries
- Core memory promotion — surface frequently-accessed facts for inclusion in always-loaded context
- `access_count` and `last_accessed` tracking activated

**Key challenge:** Reflection quality requires strong reasoning (contradiction detection, confidence calibration). Planned approach: local LLM for routine maintenance, API model (Sonnet-class) for weekly deep reflection.

---

## Design principles (all versions)

1. **Markdown is always source of truth** — the SQLite index is derived and rebuildable
2. **Additive only** — never modifies, deletes, or overwrites existing user files
3. **Offline-first** — works without network; cloud APIs are optional enhancements
4. **Seamless integration** — layers on top of any OpenClaw workspace without configuration
5. **Forward-compatible schema** — v1 schema includes reserved columns for v2/v3 to avoid migrations
