#!/usr/bin/env node
/**
 * Tests for lib/orchestrator.js — recall strategy classification.
 */
const { classifyStrategy, STRATEGY_PATTERNS, DEFAULT_STRATEGY } = require('../lib/orchestrator');
const { PROFILES, resolveProfile } = require('../lib/scoring');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

console.log('Test 1: entity_brief — "who is X" with detected entities');
{
  const r = classifyStrategy('who is Sarah Chen?', ['sarah chen']);
  assert(r.strategy === 'entity_brief', `Expected entity_brief, got ${r.strategy}`);
  assert(r.profile === 'entity_brief', `Expected profile entity_brief, got ${r.profile}`);

  const r2 = classifyStrategy('tell me about Movement Labs', ['movement labs']);
  assert(r2.strategy === 'entity_brief', `Expected entity_brief for "tell me about", got ${r2.strategy}`);

  const r3 = classifyStrategy('describe the auth middleware', ['auth middleware']);
  assert(r3.strategy === 'entity_brief', `Expected entity_brief for "describe", got ${r3.strategy}`);
}

console.log('Test 2: entity_brief requires detected entities');
{
  // "who is X" pattern matches, but no entities → fall through
  const r = classifyStrategy('who is the best dev', []);
  assert(r.strategy !== 'entity_brief',
    `Without entities, "who is..." should not classify as entity_brief, got ${r.strategy}`);
  // Should fall to default
  assert(r.strategy === 'quick_context', `Expected quick_context fallback, got ${r.strategy}`);
}

console.log('Test 3: timeline_brief — date/month/year language');
{
  const cases = [
    'what happened in March 2026?',
    'what did I do last week',
    'notes from yesterday',
    'anything on 2026-03-15',
    'remember last month',
  ];
  for (const q of cases) {
    const r = classifyStrategy(q, []);
    assert(r.strategy === 'timeline_brief', `Expected timeline_brief for "${q}", got ${r.strategy}`);
  }
}

console.log('Test 4: relationship_brief — collaboration language');
{
  const r = classifyStrategy('how does Jake work with the design team', ['jake']);
  assert(r.strategy === 'relationship_brief', `Expected relationship_brief, got ${r.strategy}`);

  const r2 = classifyStrategy('who is Sarah\'s manager', ['sarah']);
  assert(r2.strategy === 'relationship_brief', `Expected relationship_brief for "manager", got ${r2.strategy}`);

  // No entities → should not match relationship_brief (requireEntities: true)
  const r3 = classifyStrategy('what does the team collaborate on', []);
  assert(r3.strategy !== 'relationship_brief',
    `Without entities, team/collaborate should NOT be relationship_brief, got ${r3.strategy}`);
}

console.log('Test 5: verification_lookup — source/citation language');
{
  const cases = [
    'where is this written',
    'what is the source of this claim',
    'which file has the API key',
    'exact date Movement Labs shipped',
    'verbatim quote from the meeting',
  ];
  for (const q of cases) {
    const r = classifyStrategy(q, []);
    assert(r.strategy === 'verification_lookup',
      `Expected verification_lookup for "${q}", got ${r.strategy}`);
  }
}

console.log('Test 6: quick_context fallback');
{
  const cases = [
    'make me a sandwich',
    'the quick brown fox',
    'arbitrary text with no patterns',
  ];
  for (const q of cases) {
    const r = classifyStrategy(q, []);
    assert(r.strategy === 'quick_context', `Expected quick_context for "${q}", got ${r.strategy}`);
    assert(r.profile === null, `quick_context should have null profile, got ${r.profile}`);
  }
}

console.log('Test 7: edge cases');
{
  assert(classifyStrategy(null, []).strategy === 'quick_context', 'null query should default');
  assert(classifyStrategy(undefined, []).strategy === 'quick_context', 'undefined query should default');
  assert(classifyStrategy('', []).strategy === 'quick_context', 'empty query should default');
  assert(classifyStrategy(42, []).strategy === 'quick_context', 'non-string should default');
}

console.log('Test 8: all strategy profiles are registered in scoring.PROFILES');
{
  for (const [name, cfg] of Object.entries(STRATEGY_PATTERNS)) {
    assert(PROFILES[cfg.profile] != null, `Profile "${cfg.profile}" for strategy "${name}" missing from PROFILES`);
  }
  // Check quick_context alias
  assert(PROFILES['quick_context'] != null, 'quick_context alias missing from PROFILES');
  // Check semantic variants exist
  for (const [name, cfg] of Object.entries(STRATEGY_PATTERNS)) {
    const semKey = `${cfg.profile}-semantic`;
    assert(PROFILES[semKey] != null, `Semantic variant "${semKey}" missing from PROFILES`);
  }
}

console.log('Test 9: resolveProfile returns correct profile for strategies');
{
  // Strategy profiles use the additive redesign: base weights identical to
  // the default profile, with ONE strategy-specific knob added.
  const entityBrief = resolveProfile('entity_brief', false);
  assert(entityBrief.entityMention > 0,
    `entity_brief profile should have entityMention > 0 (strategy knob), got ${entityBrief.entityMention}`);
  assert(entityBrief.fts >= 0.50,
    `entity_brief should preserve fts weight (not cut it), got ${entityBrief.fts}`);

  const verification = resolveProfile('verification_lookup', false);
  assert(verification.confidenceExponent > 1.0,
    `verification_lookup should have elevated confidenceExponent (strategy knob), got ${verification.confidenceExponent}`);
  assert(verification.recencyHalfLifeDays >= 180,
    `verification_lookup should have long recency half-life (strategy knob), got ${verification.recencyHalfLifeDays}`);

  const timeline = resolveProfile('timeline_brief', false);
  assert(timeline.recencyHalfLifeDays <= 60,
    `timeline_brief should have short recency half-life (strategy knob), got ${timeline.recencyHalfLifeDays}`);

  const relationship = resolveProfile('relationship_brief', false);
  assert(relationship.entityMention > 0,
    `relationship_brief should have entityMention weight (strategy knob), got ${relationship.entityMention}`);

  // Semantic variants
  const entityBriefSem = resolveProfile('entity_brief', true);
  assert(entityBriefSem.semantic > 0,
    `entity_brief-semantic should have semantic weight, got ${entityBriefSem.semantic}`);
}

console.log('Test 10: integration — recall() uses orchestrator classified profile');
{
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { openDb } = require('../lib/store');
  const { recall } = require('../lib/recall');
  const { buildEntityIndex } = require('../lib/entities');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-orchestrator-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  const db = openDb(ws);

  // Insert a chunk mentioning Sarah Chen so entity_brief can fire
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'memory/test.md', 'Test', 'Sarah Chen leads the Movement Labs team',
    1, 1, JSON.stringify(['sarah chen', 'movement labs']), 'fact', 1.0,
    new Date().toISOString(), new Date().toISOString(), 1.0
  );
  buildEntityIndex(db);

  // Explicit profile — orchestrator should NOT override it
  const explicitRes = recall(db, 'who is Sarah Chen?', { recallProfile: 'default', explain: true });
  assert(explicitRes.explain.profile === 'default',
    `Explicit recallProfile should win, got ${explicitRes.explain.profile}`);

  // No explicit profile, query matches entity_brief pattern + has entity → should classify
  const classifiedRes = recall(db, 'who is Sarah Chen?', { explain: true });
  assert(classifiedRes.explain.strategy === 'entity_brief',
    `Expected entity_brief classification, got ${classifiedRes.explain.strategy}`);
  assert(classifiedRes.explain.profile === 'entity_brief',
    `Expected entity_brief profile, got ${classifiedRes.explain.profile}`);

  // orchestrator: false disables classification
  const disabledRes = recall(db, 'who is Sarah Chen?', { orchestrator: false, explain: true });
  assert(disabledRes.explain.strategy === 'quick_context',
    `orchestrator: false should yield quick_context, got ${disabledRes.explain.strategy}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
