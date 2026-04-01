#!/usr/bin/env node
/**
 * Integration tests for priority scoring (v9: priority affects recall ranking).
 */
const { score, RECALL_PROFILE, PRIORITY_MULTIPLIER } = require('../lib/scoring');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

const NOW = Date.now();
const RECENT = new Date(NOW - 86400000).toISOString(); // 1 day ago

function makeChunk(overrides) {
  return {
    confidence: 1.0,
    created_at: RECENT,
    chunk_type: 'fact',
    file_weight: 1.0,
    _normalizedFts: 0.8,
    priority: 'medium',
    ...overrides,
  };
}

// --- PRIORITY_MULTIPLIER values ---

console.log('Test 1: PRIORITY_MULTIPLIER values');
{
  assert(PRIORITY_MULTIPLIER.high === 1.25, `high should be 1.25, got ${PRIORITY_MULTIPLIER.high}`);
  assert(PRIORITY_MULTIPLIER.medium === 1.0, `medium should be 1.0, got ${PRIORITY_MULTIPLIER.medium}`);
  assert(PRIORITY_MULTIPLIER.low === 0.75, `low should be 0.75, got ${PRIORITY_MULTIPLIER.low}`);
}

// --- High priority ranks above medium ---

console.log('Test 2: High priority scores higher than medium');
{
  const highChunk = makeChunk({ priority: 'high' });
  const medChunk = makeChunk({ priority: 'medium' });
  const highScore = score(highChunk, NOW, RECALL_PROFILE);
  const medScore = score(medChunk, NOW, RECALL_PROFILE);
  assert(highScore > medScore, `high (${highScore.toFixed(4)}) should > medium (${medScore.toFixed(4)})`);
}

// --- Medium priority ranks above low ---

console.log('Test 3: Medium priority scores higher than low');
{
  const medChunk = makeChunk({ priority: 'medium' });
  const lowChunk = makeChunk({ priority: 'low' });
  const medScore = score(medChunk, NOW, RECALL_PROFILE);
  const lowScore = score(lowChunk, NOW, RECALL_PROFILE);
  assert(medScore > lowScore, `medium (${medScore.toFixed(4)}) should > low (${lowScore.toFixed(4)})`);
}

// --- High beats low with same FTS ---

console.log('Test 4: High priority beats low with identical FTS scores');
{
  const highChunk = makeChunk({ priority: 'high', _normalizedFts: 0.6 });
  const lowChunk = makeChunk({ priority: 'low', _normalizedFts: 0.6 });
  const highScore = score(highChunk, NOW, RECALL_PROFILE);
  const lowScore = score(lowChunk, NOW, RECALL_PROFILE);
  assert(highScore > lowScore, `high (${highScore.toFixed(4)}) should > low (${lowScore.toFixed(4)})`);
  // Verify the ratio is ~1.25/0.75 = 1.667
  const ratio = highScore / lowScore;
  assert(ratio > 1.5 && ratio < 1.8, `Ratio should be ~1.67, got ${ratio.toFixed(3)}`);
}

// --- Null/missing priority defaults to medium (1.0x) ---

console.log('Test 5: Missing priority defaults to 1.0x multiplier');
{
  const noP = makeChunk({ priority: undefined });
  const med = makeChunk({ priority: 'medium' });
  const scoreNoP = score(noP, NOW, RECALL_PROFILE);
  const scoreMed = score(med, NOW, RECALL_PROFILE);
  assert(Math.abs(scoreNoP - scoreMed) < 0.001, `null priority should equal medium: ${scoreNoP.toFixed(4)} vs ${scoreMed.toFixed(4)}`);
}

// --- Priority doesn't override other signals entirely ---

console.log('Test 6: Strong FTS can still beat weak FTS + high priority');
{
  const strongFts = makeChunk({ priority: 'low', _normalizedFts: 1.0 });
  const weakFts = makeChunk({ priority: 'high', _normalizedFts: 0.1 });
  const strongScore = score(strongFts, NOW, RECALL_PROFILE);
  const weakScore = score(weakFts, NOW, RECALL_PROFILE);
  assert(strongScore > weakScore, `Strong FTS low-priority (${strongScore.toFixed(4)}) should beat weak FTS high-priority (${weakScore.toFixed(4)})`);
}

// --- Priority interacts with confidence ---

console.log('Test 7: Priority multiplier stacks with confidence');
{
  const highConf = makeChunk({ priority: 'high', confidence: 1.0 });
  const lowConf = makeChunk({ priority: 'high', confidence: 0.3 });
  const highScore = score(highConf, NOW, RECALL_PROFILE);
  const lowScore = score(lowConf, NOW, RECALL_PROFILE);
  assert(highScore > lowScore, `High confidence (${highScore.toFixed(4)}) should beat low confidence (${lowScore.toFixed(4)}) at same priority`);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
