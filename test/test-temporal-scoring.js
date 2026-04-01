#!/usr/bin/env node
/**
 * Integration tests for temporal relevance scoring (v9: three-date model).
 */
const { score, RECALL_PROFILE, computeTemporalRelevance } = require('../lib/scoring');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

const NOW = Date.now();
const RECENT = new Date(NOW - 86400000).toISOString();

function makeChunk(overrides) {
  return {
    confidence: 1.0,
    created_at: RECENT,
    chunk_type: 'fact',
    file_weight: 1.0,
    _normalizedFts: 0.8,
    priority: 'medium',
    referenced_date: null,
    ...overrides,
  };
}

// --- computeTemporalRelevance unit tests ---

console.log('Test 1: Exact match — referenced_date within query range');
{
  const chunk = { referenced_date: '2026-03-15' };
  const qf = { since: '2026-03-15T00:00:00.000Z', until: '2026-03-16T00:00:00.000Z' };
  assert(computeTemporalRelevance(chunk, qf) === 1.0, 'Should be 1.0 for exact match');
}

console.log('Test 2: Near match — within 3 days of range');
{
  const chunk = { referenced_date: '2026-03-13' };
  const qf = { since: '2026-03-15T00:00:00.000Z', until: '2026-03-16T00:00:00.000Z' };
  assert(computeTemporalRelevance(chunk, qf) === 0.5, 'Should be 0.5 for near match');
}

console.log('Test 3: No match — outside range');
{
  const chunk = { referenced_date: '2026-01-01' };
  const qf = { since: '2026-03-15T00:00:00.000Z', until: '2026-03-16T00:00:00.000Z' };
  assert(computeTemporalRelevance(chunk, qf) === 0.0, 'Should be 0.0 for no match');
}

console.log('Test 4: No referenced_date — returns 0');
{
  const chunk = { referenced_date: null };
  const qf = { since: '2026-03-15T00:00:00.000Z' };
  assert(computeTemporalRelevance(chunk, qf) === 0.0, 'Should be 0.0 for null date');
}

console.log('Test 5: No query features — returns 0');
{
  const chunk = { referenced_date: '2026-03-15' };
  assert(computeTemporalRelevance(chunk, null) === 0.0, 'Should be 0.0 for null features');
  assert(computeTemporalRelevance(chunk, { since: null }) === 0.0, 'Should be 0.0 for null since');
}

// --- Scoring integration ---

console.log('Test 6: Temporal relevance boosts chunk score when active');
{
  const withTemporal = makeChunk({ _temporalRelevance: 1.0 });
  const withoutTemporal = makeChunk({ _temporalRelevance: 0 });
  const scoreWith = score(withTemporal, NOW, RECALL_PROFILE);
  const scoreWithout = score(withoutTemporal, NOW, RECALL_PROFILE);
  assert(scoreWith > scoreWithout, `Temporal chunk (${scoreWith.toFixed(4)}) should > non-temporal (${scoreWithout.toFixed(4)})`);
}

console.log('Test 7: No temporal enrichment — no effect on score');
{
  const noEnrich = makeChunk({});
  const explicit0 = makeChunk({ _temporalRelevance: 0 });
  const s1 = score(noEnrich, NOW, RECALL_PROFILE);
  const s2 = score(explicit0, NOW, RECALL_PROFILE);
  assert(Math.abs(s1 - s2) < 0.001, `Should be equal: ${s1.toFixed(4)} vs ${s2.toFixed(4)}`);
}

console.log('Test 8: Chunk with matching referenced_date ranks higher than created_at-only chunk');
{
  // Simulate: query for "last Monday" (March 30 2026)
  const queryFeatures = { since: '2026-03-30T00:00:00.000Z', until: '2026-03-31T00:00:00.000Z' };

  // Chunk A: referenced_date matches the query, created recently
  const chunkA = makeChunk({
    referenced_date: '2026-03-30',
    _temporalRelevance: computeTemporalRelevance({ referenced_date: '2026-03-30' }, queryFeatures),
  });

  // Chunk B: created on March 30 but references a different date
  const chunkB = makeChunk({
    created_at: '2026-03-30T12:00:00.000Z',
    referenced_date: '2026-02-15',
    _temporalRelevance: computeTemporalRelevance({ referenced_date: '2026-02-15' }, queryFeatures),
  });

  const scoreA = score(chunkA, NOW, RECALL_PROFILE);
  const scoreB = score(chunkB, NOW, RECALL_PROFILE);
  assert(scoreA > scoreB, `referenced_date match (${scoreA.toFixed(4)}) should > created_at match (${scoreB.toFixed(4)})`);
}

console.log('Test 9: Temporal weight inactive for non-temporal queries');
{
  // When _temporalRelevance is 0 for all chunks, temporal weight shouldn't affect relative ordering
  const highFts = makeChunk({ _normalizedFts: 1.0, _temporalRelevance: 0 });
  const lowFts = makeChunk({ _normalizedFts: 0.3, _temporalRelevance: 0 });
  const s1 = score(highFts, NOW, RECALL_PROFILE);
  const s2 = score(lowFts, NOW, RECALL_PROFILE);
  assert(s1 > s2, `High FTS (${s1.toFixed(4)}) should still beat low FTS (${s2.toFixed(4)})`);
}

console.log('Test 10: Open-ended since (no until) — exact match');
{
  const chunk = { referenced_date: '2026-03-20' };
  const qf = { since: '2026-03-15T00:00:00.000Z', until: null };
  assert(computeTemporalRelevance(chunk, qf) === 1.0, 'Should match when referenced_date >= since with no until');
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
