# SME v6.9.0 — Recall Quality Overhaul

**Date:** March 2, 2026
**Baseline:** v6.8.0 — 5.4/10 on 5-query benchmark
**Target:** 8.5+/10

---

## Executive Summary

Three critical bugs prevent MEMORY.md (the highest-value file at 1.5x weight) from surfacing for the most important queries. All three are in lib/recall.js.

---

## Bug 1: Semantic Rescue Iterates in DB Insertion Order (CRITICAL)

**File:** lib/recall.js — rescue pass (~line 205-230)

**Problem:** The rescue pass scans ALL embedded chunks to find high-similarity results that FTS missed. It iterates in DB insertion order and stops after RESCUE_MAX = 10 hits above RESCUE_MIN_SIM = 0.30.

MEMORY.md chunks are at position ~1984 of 2204 in the DB (indexed last). There are 93 chunks above 0.30 similarity before MEMORY.md in DB order. The rescue grabs the first 10 irrelevant chunks (SOUL.md, TOOLS.md, VOICE.md) and stops — never reaching MEMORY.md.

**Evidence:**
- Rescue grabs: SOUL.md (sim=0.35), STATE.md (0.32), TOOLS.md (0.36), VOICE.md (0.43) — all low-value
- MEMORY.md "Current Stack" has sim=0.42 but at DB position 1984 — NEVER REACHED

**Fix:** Compute similarity for ALL embedded chunks first, sort by similarity descending, then take top RESCUE_MAX.

```javascript
// BEFORE (broken):
for (const row of allEmbedded) {
  if (rescueCount >= RESCUE_MAX) break;  // stops too early
  if (sim < RESCUE_MIN_SIM) continue;
  rows.push(row);
  rescueCount++;
}

// AFTER (correct):
const rescueCandidates = [];
for (const row of allEmbedded) {
  if (ftsIds.has(row.id)) continue;
  const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  const sim = cosineSimilarity(queryEmbedding, vec);
  if (sim < RESCUE_MIN_SIM) continue;
  if (sinceDate && row.created_at < sinceDate) continue;
  if (untilDate && row.created_at >= untilDate) continue;
  if (chunkType && row.chunk_type !== chunkType) continue;
  if (minConfidence != null && row.confidence < minConfidence) continue;
  if (excludePatterns && excludePatterns.length > 0 && isExcludedFromRecall(row.file_path, excludePatterns)) continue;

  row.rank = 0;
  row._normalizedFts = sim * 0.3;
  row._semanticSim = sim;
  rescueCandidates.push(row);
}
rescueCandidates.sort((a, b) => b._semanticSim - a._semanticSim);
for (const row of rescueCandidates.slice(0, RESCUE_MAX)) {
  rows.push(row);
  ftsIds.add(row.id);
}
```

**Performance:** ~2200 cosine sims on 384-dim vectors = <1ms on M-series. No concern.

---

## Bug 2: FTS AND-Match Fails on Partial Keyword Overlap (HIGH)

**File:** lib/recall.js — sanitizeFtsQuery() and main recall flow

**Problem:** sanitizeFtsQuery() creates AND query: "JB" "portfolio" "allocation" "framework". FTS5 requires ALL terms. MEMORY.md "Portfolio Framework" chunk has "portfolio" and "framework" but NOT "allocation" — invisible to FTS.

The OR fallback only triggers when AND returns 0 results. Since spec files containing the exact test query text return hits, OR never fires.

**Evidence:**
- FTS "JB" "portfolio" "allocation" "framework" -> 2 hits (both spec files)
- FTS "portfolio" "framework" -> 10 hits, MEMORY.md #1 at rank=-13.12

**Fix:** Always run both AND and OR queries, merge results. AND matches get 1.3x boost.

```javascript
let rows = [];
if (sanitized) {
  rows = search(db, sanitized, searchOpts);

  // Always also run OR query with alias expansion
  const orQuery = buildOrQuery(temporal.strippedQuery || query, aliases);
  if (orQuery) {
    const orRows = search(db, orQuery, searchOpts);
    const existingIds = new Set(rows.map(r => r.id));
    for (const r of rows) { r._andMatch = true; }
    for (const r of orRows) {
      if (!existingIds.has(r.id)) {
        r._andMatch = false;
        rows.push(r);
      }
    }
  }
}
```

Then in scoring/post-ranking, apply 1.3x boost to _andMatch = true rows.

---

## Bug 3: Spec/Build Artifact Pollution (MEDIUM)

**Problem:** 461 chunks (21% of index) are SME spec files (data/sme-*.md). They contain test queries verbatim, so they get near-perfect FTS matches against real user queries.

**Evidence:**
- "supplements" query: top 2 FTS hits are data/sme-v6.6-spec.md — contain literal "What supplements is JB taking?"
- Most spec files at 0.80x weight, some at 0.30x — even 0.30x with perfect FTS match beats 1.5x MEMORY.md with partial match

**Fix (two-part):**

Part A — Add to excludeFromRecall in workspace .memory/config.json:
```json
{
  "excludeFromRecall": [
    "data/sme-*-spec.md",
    "data/sme-*-test*.md",
    "data/sme-launch-tweet.md",
    "data/sme-readme-draft.md"
  ]
}
```

Part B — Self-reference detection (defense in depth):
```javascript
function applySelfReferencePenalty(results, query) {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (normalizedQuery.length < 15) return;

  for (const r of results) {
    const content = (r.content || '').toLowerCase();
    if (content.includes(normalizedQuery)) {
      const idx = content.indexOf(normalizedQuery);
      const context = content.substring(Math.max(0, idx - 50), idx + normalizedQuery.length + 50);
      if (/\b(test|query|expected|diagnostic|score|spec|benchmark)\b/i.test(context)) {
        r.score *= 0.5;
        r.finalScore *= 0.5;
      }
    }
  }
}
```

---

## Bug 4: FTS Normalization Distortion (LOW-MEDIUM)

**File:** lib/scoring.js — normalizeFtsScores()

**Problem:** When spec files with rank -16.3 are in same set as real results at -6.9, normalization compresses real results. Spec gets 1.00, real content gets 0.53.

**Fix:** Percentile-based normalization:
```javascript
function normalizeFtsScores(results) {
  if (results.length === 0) return;
  if (results.length === 1) { results[0]._normalizedFts = 1.0; return; }

  const ranks = results.map(r => r.rank);
  const sorted = [...ranks].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const range = p90 - p10 || 1;

  for (const r of results) {
    const clamped = Math.max(p10, Math.min(p90, r.rank));
    r._normalizedFts = 0.3 + 0.7 * (p90 - clamped) / range;
  }
}
```

Largely addressed by Bug 3, but good defense-in-depth.

---

## Implementation Priority

1 -> Rescue insertion-order (CRITICAL, ~10 lines, P0)
2 -> AND-only FTS (HIGH, ~30 lines, P0)
3 -> Spec pollution (MEDIUM, config + ~20 lines, P1)
4 -> FTS normalization (LOW-MED, ~10 lines, P2)

Bugs 1+2 alone should push 5.4 -> ~7.5+. Adding 3+4 should reach 8.5+.

---

## Test Plan

### Benchmark Queries

| # | Query | v6.8 | Target | Pass Criteria |
|---|-------|------|--------|---------------|
| 1 | What supplements is JB taking? | 3/10 | 9/10 | MEMORY.md "Current Stack" in top 2 |
| 2 | What is the bromantane protocol and dosing? | 5/10 | 9/10 | MEMORY.md "Bromantane Protocol" in top 2 |
| 3 | What is JB portfolio allocation framework? | 2/10 | 9/10 | MEMORY.md "Portfolio Framework" in top 2 |
| 4 | What cron jobs are active? | 9/10 | 9/10 | MEMORY.md "Cron Jobs" stays #1 |
| 5 | What were the issues found in last night SME sprint? | 8/10 | 8/10 | Correct daily memory file in top 3 |

### Regression
- All existing 47 tests must pass
- Temporal queries still resolve correctly
- Intent detection still boosts appropriately
- Rule penalty still works for factual queries
- Recency decay still functions

### New Unit Tests

```javascript
// Bug 1: Rescue sorts by similarity
test('rescue pass returns highest-similarity chunks regardless of DB order');

// Bug 2: OR fallback always runs
test('OR query runs even when AND returns results');

// Bug 3: Self-reference penalty
test('chunks containing literal query text in spec context get penalized');
```

---

## Files to Modify

1. lib/recall.js — Bugs 1, 2, 3 (self-reference penalty)
2. lib/scoring.js — Bug 4 (normalization)
3. WORKSPACE .memory/config.json (/Users/jj/clawd/.memory/config.json) — Bug 3 (excludeFromRecall). CHECK EXISTING CONFIG FIRST, merge don't overwrite.
4. test/test-recall.js — New tests
5. package.json — Bump to 6.9.0

---

## Workspace Context

- Repo: /Users/jj/Structured-Memory-Engine
- Index DB: /Users/jj/clawd/.memory/sme.db (SQLite, better-sqlite3)
- Test: npm test (runs all test suites)
- Config: /Users/jj/clawd/.memory/config.json (user config)
- Total chunks: 2,208 | With embeddings: 2,204 (99.8%)
- MEMORY.md: 40 chunks, all at 1.5x file_weight, all with embeddings

After implementing, run the 5-query benchmark:
```bash
node -e "
const { create } = require('./lib/api');
const sme = create({ workspace: '/Users/jj/clawd' });
const queries = [
  'What supplements is JB taking?',
  'What is the bromantane protocol and dosing?',
  'What is JB portfolio allocation framework?',
  'What cron jobs are active?',
  'What were the issues found in last night SME sprint?'
];
(async () => {
  for (const q of queries) {
    console.log('\n=== ' + q + ' ===');
    const r = await sme.query(q, { limit: 5 });
    (Array.isArray(r) ? r : []).slice(0,3).forEach((c,i) =>
      console.log('#'+(i+1)+' score='+c.score.toFixed(3)+' fw='+c.fileWeight+' '+c.filePath+' | '+(c.heading||'').substring(0,50))
    );
  }
})();
"
```
