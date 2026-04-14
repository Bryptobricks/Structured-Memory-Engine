# Changelog

All notable changes to Structured Memory Engine will be documented in this file.

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
