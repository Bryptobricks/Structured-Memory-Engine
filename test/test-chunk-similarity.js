#!/usr/bin/env node
/**
 * Tests for computeChunkSimilarity() — v9 restructuring.
 */
const { computeChunkSimilarity } = require('../lib/reflect');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function makeChunk(content, entities, filePath) {
  return {
    content,
    entities: JSON.stringify(entities || []),
    file_path: filePath || 'memory/2026-03-01.md',
  };
}

// --- High similarity: same topic, same entity ---

console.log('Test 1: Same entity, same topic — high similarity');
{
  const a = makeChunk('JB takes Cialis 5mg daily', ['JB', 'Cialis']);
  const b = makeChunk('JB takes Cialis 5mg every morning', ['JB', 'Cialis']);
  const sim = computeChunkSimilarity(a, b);
  assert(sim > 0.5, `Expected > 0.5, got ${sim.toFixed(3)}`);
}

// --- Low similarity: different topics ---

console.log('Test 2: Different topics — low similarity');
{
  const a = makeChunk('JB takes Cialis 5mg daily', ['JB', 'Cialis']);
  const b = makeChunk('Tesla reported record Q4 earnings', ['Tesla']);
  const sim = computeChunkSimilarity(a, b);
  assert(sim < 0.3, `Expected < 0.3, got ${sim.toFixed(3)}`);
}

// --- Medium similarity: same entity, different topic ---

console.log('Test 3: Same entity, different topic — moderate similarity');
{
  const a = makeChunk('JB weighs 200 lbs', ['JB']);
  const b = makeChunk('JB portfolio is 60% crypto', ['JB']);
  const sim = computeChunkSimilarity(a, b);
  assert(sim > 0.1 && sim <= 0.65, `Expected between 0.1-0.65, got ${sim.toFixed(3)}`);
}

// --- Same file bonus ---

console.log('Test 4: Same file adds bonus');
{
  const a = makeChunk('daily supplement routine', ['JB'], 'memory/2026-03-01.md');
  const b = makeChunk('daily supplement routine updated', ['JB'], 'memory/2026-03-01.md');
  const c = makeChunk('daily supplement routine updated', ['JB'], 'memory/2026-03-15.md');
  const simSame = computeChunkSimilarity(a, b);
  const simDiff = computeChunkSimilarity(a, c);
  assert(simSame > simDiff, `Same file (${simSame.toFixed(3)}) should > different file (${simDiff.toFixed(3)})`);
}

// --- Empty entities ---

console.log('Test 5: No entities — relies on term overlap');
{
  const a = makeChunk('the weather was nice today', []);
  const b = makeChunk('the weather was terrible today', []);
  const sim = computeChunkSimilarity(a, b);
  assert(sim > 0, `Should have some term overlap, got ${sim.toFixed(3)}`);
}

// --- Completely different content ---

console.log('Test 6: Completely unrelated — near zero');
{
  const a = makeChunk('quantum computing breakthrough', ['IBM']);
  const b = makeChunk('chocolate cake recipe ingredients', []);
  const sim = computeChunkSimilarity(a, b);
  assert(sim < 0.15, `Expected near 0, got ${sim.toFixed(3)}`);
}

// --- Null/broken entities field ---

console.log('Test 7: Null entities handled gracefully');
{
  const a = makeChunk('some content here', null);
  const b = { content: 'some content here', entities: null, file_path: 'test.md' };
  const sim = computeChunkSimilarity(a, b);
  assert(typeof sim === 'number' && !isNaN(sim), `Should return a number, got ${sim}`);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
