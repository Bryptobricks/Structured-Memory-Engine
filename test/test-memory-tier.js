#!/usr/bin/env node
/**
 * Tests for lib/memory-tier.js — classification, promotion, multipliers.
 * Also covers end-to-end integration: recall() records stats and promotes inline.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  classifyTier, checkPromotion,
  TIER_MULTIPLIERS, PROMOTION_RULES, TYPE_FAST_PATHS,
} = require('../lib/memory-tier');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

console.log('Test 1: classifyTier — type fast-paths');
{
  assert(classifyTier({ chunk_type: 'preference', content: 'likes dark mode' }) === 'durable_personal',
    'preference → durable_personal');
  assert(classifyTier({ chunk_type: 'confirmed', content: 'arbitrary' }) === 'durable_personal',
    'confirmed → durable_personal');
  assert(classifyTier({ chunk_type: 'decision', content: 'chose Postgres' }) === 'durable_project',
    'decision → durable_project');
  assert(classifyTier({ chunk_type: 'action_item', content: 'follow up on auth migration' }) === 'durable_project',
    'action_item → durable_project');
}

console.log('Test 2: classifyTier — ops_runbook regex');
{
  const cases = [
    { content: 'curl -X POST localhost:3000/api' },
    { content: 'Set API_KEY in .env' },
    { content: 'npm install foo' },
    { content: 'chmod +x script.sh' },
    { content: 'webhook URL is https://example.com' },
  ];
  for (const c of cases) {
    assert(classifyTier(c) === 'ops_runbook', `Expected ops_runbook for "${c.content}"`);
  }
}

console.log('Test 3: classifyTier — personal / project regex');
{
  assert(classifyTier({ content: 'her birthday is March 12' }) === 'durable_personal', 'birthday → personal');
  assert(classifyTier({ content: 'bloodwork results came back good' }) === 'durable_personal', 'bloodwork → personal');
  assert(classifyTier({ content: 'shipped v2.3 last Thursday' }) === 'durable_project', 'shipped → project');
  assert(classifyTier({ content: 'PR #456 merged into main' }) === 'durable_project', 'PR # → project');
}

console.log('Test 4: classifyTier — default is working_reference');
{
  assert(classifyTier({ content: 'random note about something' }) === 'working_reference', 'no match → working_reference');
  assert(classifyTier({}) === 'working_reference', 'empty chunk → working_reference');
  assert(classifyTier(null) === 'working_reference', 'null chunk → working_reference');
}

console.log('Test 5: classifyTier — ops_runbook beats personal/project');
{
  // A chunk that mentions both a webhook AND "shipped" — ops wins
  const chunk = { content: 'shipped webhook endpoint for payments' };
  assert(classifyTier(chunk) === 'ops_runbook', 'ops_runbook should win when both match');
}

console.log('Test 6: checkPromotion — thresholds');
{
  // Below threshold → no promotion
  const notReady = { memory_tier: 'working_reference', recall_count: 4, unique_query_count: 3 };
  assert(checkPromotion(notReady) === null, '4 recalls → no promotion');

  // Threshold met → promote
  const ready = { memory_tier: 'working_reference', recall_count: 5, unique_query_count: 3 };
  assert(checkPromotion(ready) === 'durable_project', 'working_reference + 5/3 → durable_project');

  // Unique queries matter — 5 recalls but only 1 unique query → not enough
  const notEnoughUnique = { memory_tier: 'working_reference', recall_count: 5, unique_query_count: 1 };
  assert(checkPromotion(notEnoughUnique) === null, '5 recalls but 1 unique query → no promotion');

  // ops_runbook promotion
  const opsReady = { memory_tier: 'ops_runbook', recall_count: 10, unique_query_count: 5 };
  assert(checkPromotion(opsReady) === 'working_reference', 'ops_runbook 10/5 → working_reference');

  // durable tiers don't promote further
  const alreadyDurable = { memory_tier: 'durable_project', recall_count: 100, unique_query_count: 50 };
  assert(checkPromotion(alreadyDurable) === null, 'durable_project has no further promotion');
}

console.log('Test 7: TIER_MULTIPLIERS values');
{
  assert(TIER_MULTIPLIERS.durable_personal === 1.0, 'durable_personal = 1.0x');
  assert(TIER_MULTIPLIERS.durable_project === 1.0, 'durable_project = 1.0x');
  assert(TIER_MULTIPLIERS.working_reference === 0.75, 'working_reference = 0.75x');
  assert(TIER_MULTIPLIERS.ops_runbook === 0.45, 'ops_runbook = 0.45x');
}

console.log('Test 8: score() — tier multiplier suppresses ops_runbook');
{
  const { score, CIL_PROFILE } = require('../lib/scoring');
  const nowMs = Date.now();
  const base = {
    confidence: 1.0,
    created_at: new Date().toISOString(),
    chunk_type: 'fact',
    file_weight: 1.0,
    _normalizedFts: 0.8,
    content: 'some relevant note about the api',
  };
  const personal = { ...base, memory_tier: 'durable_personal' };
  const ops = { ...base, memory_tier: 'ops_runbook' };
  const personalScore = score(personal, nowMs, CIL_PROFILE);
  const opsScore = score(ops, nowMs, CIL_PROFILE);
  assert(personalScore > opsScore,
    `durable_personal (${personalScore.toFixed(3)}) should beat ops_runbook (${opsScore.toFixed(3)})`);
  // ops_runbook should be roughly 0.45x relative to durable_personal
  const ratio = opsScore / personalScore;
  assert(Math.abs(ratio - 0.45) < 0.01, `ops/personal ratio should be ~0.45, got ${ratio.toFixed(3)}`);
}

console.log('Test 9: insertChunks — classifies tier at ingest');
{
  const { openDb, insertChunks } = require('../lib/store');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-tier-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  const db = openDb(ws);

  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'curl -X POST localhost:8080/hook', heading: 'Ops', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
    { content: 'She prefers dark mode', heading: 'Prefs', lineStart: 2, lineEnd: 2, entities: [], chunkType: 'preference' },
    { content: 'Shipped v2.1 to production', heading: 'Release', lineStart: 3, lineEnd: 3, entities: [], chunkType: 'fact' },
    { content: 'Random notes that dont match patterns', heading: 'Misc', lineStart: 4, lineEnd: 4, entities: [], chunkType: 'raw' },
  ], null);

  const rows = db.prepare('SELECT content, memory_tier FROM chunks ORDER BY line_start').all();
  assert(rows[0].memory_tier === 'ops_runbook', `ops_runbook for curl, got ${rows[0].memory_tier}`);
  assert(rows[1].memory_tier === 'durable_personal', `durable_personal for preference, got ${rows[1].memory_tier}`);
  assert(rows[2].memory_tier === 'durable_project', `durable_project for shipped, got ${rows[2].memory_tier}`);
  assert(rows[3].memory_tier === 'working_reference', `working_reference for random, got ${rows[3].memory_tier}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 10: recall() — inline promotion via recordRecallStats');
{
  const { openDb, insertChunks } = require('../lib/store');
  const { recall } = require('../lib/recall');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-promo-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  const db = openDb(ws);

  // Insert a working_reference chunk
  insertChunks(db, 'memory/facts.md', Date.now(), [
    { content: 'The redis cache TTL is 120 seconds for sessions', heading: 'Cache', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  const initialTier = db.prepare('SELECT memory_tier, recall_count, unique_query_count FROM chunks LIMIT 1').get();
  assert(initialTier.memory_tier === 'working_reference', `initial tier working_reference, got ${initialTier.memory_tier}`);
  assert(initialTier.recall_count === 0, `initial recall_count 0, got ${initialTier.recall_count}`);

  // Recall the same chunk across 5 different queries (need 5 recalls + 3 unique for promotion)
  const queries = ['redis cache', 'TTL sessions', 'cache ttl time', 'redis', 'session ttl'];
  for (const q of queries) {
    recall(db, q, { limit: 5, workspace: ws, orchestrator: false });
  }

  const afterTier = db.prepare('SELECT memory_tier, recall_count, unique_query_count FROM chunks LIMIT 1').get();
  assert(afterTier.recall_count === 5, `recall_count should be 5, got ${afterTier.recall_count}`);
  assert(afterTier.unique_query_count === 5, `unique_query_count should be 5, got ${afterTier.unique_query_count}`);
  assert(afterTier.memory_tier === 'durable_project',
    `Expected promotion to durable_project, got ${afterTier.memory_tier}`);

  // Repeated identical query shouldn't increment unique_query_count
  recall(db, 'redis cache', { limit: 5, workspace: ws, orchestrator: false });
  const afterRepeat = db.prepare('SELECT recall_count, unique_query_count FROM chunks LIMIT 1').get();
  assert(afterRepeat.recall_count === 6, `recall_count should be 6, got ${afterRepeat.recall_count}`);
  assert(afterRepeat.unique_query_count === 5, `unique_query_count should still be 5, got ${afterRepeat.unique_query_count}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 11: recall() — recordStats: false suppresses promotion');
{
  const { openDb, insertChunks } = require('../lib/store');
  const { recall } = require('../lib/recall');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-nostats-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  const db = openDb(ws);

  insertChunks(db, 'memory/facts.md', Date.now(), [
    { content: 'Observation about system behavior', heading: 'Obs', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  // Recall many times with recordStats: false
  for (let i = 0; i < 10; i++) {
    recall(db, `unique query ${i}`, { limit: 5, workspace: ws, recordStats: false, orchestrator: false });
  }

  const after = db.prepare('SELECT recall_count FROM chunks LIMIT 1').get();
  assert(after.recall_count === 0, `recordStats: false should leave recall_count at 0, got ${after.recall_count}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
