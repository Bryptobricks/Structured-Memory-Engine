#!/usr/bin/env node
const { shouldRecall } = require('../lib/recall-gate');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

console.log('Test 1: Acknowledgments are gated');
{
  for (const ack of ['ok', 'okay', 'thanks', 'thank you', 'got it', 'lol', 'yes', 'no', 'cool.', 'hmm', 'k']) {
    const r = shouldRecall(ack);
    assert(r.shouldRecall === false, `Expected "${ack}" to be gated, got shouldRecall=${r.shouldRecall}`);
  }
  const thanksExclaim = shouldRecall('thanks!');
  assert(thanksExclaim.shouldRecall === false && thanksExclaim.reason === 'acknowledgment',
    `"thanks!" should be acknowledgment, got reason=${thanksExclaim.reason}`);
}

console.log('Test 2: Math expressions are gated');
{
  const cases = ['2 + 2', '100 * 0.5', '1+1=2', '3.14 * 2', '50%'];
  for (const m of cases) {
    const r = shouldRecall(m);
    assert(r.shouldRecall === false, `Expected "${m}" to be gated as math, got shouldRecall=${r.shouldRecall} reason=${r.reason}`);
  }
  // Words mixed with math should NOT be gated as math
  const mixed = shouldRecall('what is 2 + 2');
  assert(mixed.shouldRecall === true, `"what is 2 + 2" should pass (has word chars), got gated: ${mixed.reason}`);
}

console.log('Test 3: System commands are gated');
{
  for (const cmd of ['/clear', '/reset', '/help', '/version', '/debug', '/quit', '/exit', '/status']) {
    const r = shouldRecall(cmd);
    assert(r.shouldRecall === false && r.reason === 'system command',
      `Expected "${cmd}" gated as system command, got shouldRecall=${r.shouldRecall} reason=${r.reason}`);
  }
}

console.log('Test 4: Real queries pass the gate');
{
  const queries = [
    'what did Sarah say about the project?',
    'tell me about Movement Labs',
    'how does the auth middleware work',
    'what happened last Thursday',
    'explain the scoring profile system',
  ];
  for (const q of queries) {
    const r = shouldRecall(q);
    assert(r.shouldRecall === true, `Expected "${q}" to pass gate, got gated: ${r.reason}`);
  }
}

console.log('Test 5: Short messages are gated');
{
  const r1 = shouldRecall('k');
  assert(r1.shouldRecall === false, `"k" should be gated, got shouldRecall=${r1.shouldRecall}`);
  const r2 = shouldRecall('');
  assert(r2.shouldRecall === false && r2.reason === 'empty', `Empty string should be empty, got ${r2.reason}`);
  const r3 = shouldRecall('  ', {});
  assert(r3.shouldRecall === false, `Whitespace should be gated, got shouldRecall=${r3.shouldRecall}`);
  // minMessageLength override
  const r4 = shouldRecall('hi', { recallGating: { minMessageLength: 10 } });
  assert(r4.shouldRecall === false && r4.reason === 'too short', `With minLength=10, "hi" should be too short, got ${r4.reason}`);
}

console.log('Test 6: Non-string inputs fail safe');
{
  const r1 = shouldRecall(null);
  assert(r1.shouldRecall === false, 'null should be gated');
  const r2 = shouldRecall(undefined);
  assert(r2.shouldRecall === false, 'undefined should be gated');
  const r3 = shouldRecall(42);
  assert(r3.shouldRecall === false, 'number should be gated');
}

console.log('Test 7: Gate integration with context.js — gated message returns empty');
{
  // Spin up a minimal in-memory DB and call getRelevantContext
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-gate-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });

  const { openDb } = require('../lib/store');
  const { getRelevantContext } = require('../lib/context');
  const db = openDb(ws);

  // Insert a fact so the DB has SOME content
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'memory/test.md', 'Test', 'Sarah Chen is the lead engineer on Movement Labs',
    1, 1, JSON.stringify(['sarah chen', 'movement labs']), 'fact', 1.0,
    new Date().toISOString(), new Date().toISOString(), 1.0
  );

  // Gated message — should return empty with gated:true
  const gatedResult = getRelevantContext(db, 'ok', { workspace: ws });
  assert(gatedResult.gated === true, `Expected gated=true for "ok", got ${JSON.stringify(gatedResult)}`);
  assert(gatedResult.text === '', 'Expected empty text for gated message');
  assert(gatedResult.chunks.length === 0, 'Expected no chunks for gated message');
  assert(gatedResult.gateReason === 'acknowledgment', `Expected reason=acknowledgment, got ${gatedResult.gateReason}`);

  // Real query — should NOT be gated
  const realResult = getRelevantContext(db, 'tell me about Sarah Chen', { workspace: ws });
  assert(realResult.gated !== true, `Real query should not be gated, got ${JSON.stringify({gated: realResult.gated})}`);

  // skipGate: true — bypass gate even for trivial message
  const bypassResult = getRelevantContext(db, 'ok', { workspace: ws, skipGate: true });
  assert(bypassResult.gated !== true, 'skipGate should bypass the gate');

  // recallGating.enabled: false — bypass via config
  const disabledResult = getRelevantContext(db, 'ok', { workspace: ws, recallGating: { enabled: false } });
  assert(disabledResult.gated !== true, 'recallGating.enabled=false should disable the gate');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
