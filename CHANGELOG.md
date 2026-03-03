# Changelog

All notable changes to Structured Memory Engine will be documented in this file.

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
