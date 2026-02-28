#!/usr/bin/env node
/**
 * Tests for temporal.js — temporal query preprocessing and attribution detection.
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { resolveTemporalQuery, isAttributionQuery } = require('../lib/temporal');
const { getRelevantContext, invalidateEntityCache } = require('../lib/context');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Fixed date for deterministic tests: Feb 28, 2026 09:30 PST
const NOW = new Date('2026-02-28T17:30:00.000Z');

function createDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE chunks ADD COLUMN file_weight REAL DEFAULT 1.0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN last_accessed TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN stale INTEGER DEFAULT 0'); } catch (_) {}
  try {
    db.exec('DROP TRIGGER IF EXISTS chunks_au');
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content, heading, entities ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading, entities) VALUES ('delete', old.id, old.content, old.heading, old.entities);
      INSERT INTO chunks_fts(rowid, content, heading, entities) VALUES (new.id, new.content, new.heading, new.entities);
    END;`);
  } catch (_) {}
  return db;
}

function insertChunk(db, { content, filePath = 'test.md', chunkType = 'fact', confidence = 1.0, createdAt = null, entities = '[]', fileWeight = 1.0 } = {}) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, stale)
    VALUES (?, NULL, ?, 1, 10, ?, ?, ?, ?, ?, ?, 0)`).run(
    filePath, content, entities, chunkType, confidence, createdAt || now, now, fileWeight
  ).lastInsertRowid;
}

// ─── Test 1: yesterday resolves to correct date ───
console.log('Test 1: yesterday resolves to correct date');
{
  const r = resolveTemporalQuery('what happened yesterday?', NOW);
  assert(r.since.includes('2026-02-27'), `Expected since=2026-02-27, got ${r.since}`);
  assert(r.until.includes('2026-02-28'), `Expected until=2026-02-28, got ${r.until}`);
  assert(r.dateTerms.includes('2026-02-27'), 'Expected 2026-02-27 in dateTerms');
  assert(r.strippedQuery === 'what happened?', `Expected stripped query, got: "${r.strippedQuery}"`);
  assert(r.recencyBoost === null, 'yesterday should not override recencyBoost');
}

// ─── Test 2: today resolves to current date ───
console.log('Test 2: today resolves to current date');
{
  const r = resolveTemporalQuery('what did I do today?', NOW);
  assert(r.since.includes('2026-02-28'), `Expected since=2026-02-28, got ${r.since}`);
  assert(r.until === null, 'today should not have until');
  assert(r.dateTerms.includes('2026-02-28'), 'Expected 2026-02-28 in dateTerms');
}

// ─── Test 3: last week sets range and recency boost ───
console.log('Test 3: last week sets range and recency boost');
{
  const r = resolveTemporalQuery('what did we do last week?', NOW);
  assert(r.since !== null, 'last week should set since');
  assert(r.until !== null, 'last week should set until');
  assert(r.recencyBoost === 14, `Expected recencyBoost=14, got ${r.recencyBoost}`);
  assert(!r.strippedQuery.includes('last week'), 'last week should be stripped');
}

// ─── Test 4: recently sets 7-day window ───
console.log('Test 4: recently sets 7-day window');
{
  const r = resolveTemporalQuery('what changed recently?', NOW);
  assert(r.since.includes('2026-02-21'), `Expected since ~2026-02-21, got ${r.since}`);
  assert(r.recencyBoost === 7, `Expected recencyBoost=7, got ${r.recencyBoost}`);
}

// ─── Test 5: when did I start widens window ───
console.log('Test 5: when did I start widens window');
{
  const r = resolveTemporalQuery('when did I start bromantane?', NOW);
  assert(r.recencyBoost === 90, `Expected recencyBoost=90, got ${r.recencyBoost}`);
  assert(r.since === null, 'when did I start should not set since');
  assert(r.strippedQuery === 'bromantane?', `Expected stripped to "bromantane?", got: "${r.strippedQuery}"`);
}

// ─── Test 6: no temporal language returns nulls ───
console.log('Test 6: no temporal language returns nulls');
{
  const r = resolveTemporalQuery('how is my bromantane protocol?', NOW);
  assert(r.since === null, 'No temporal → since=null');
  assert(r.until === null, 'No temporal → until=null');
  assert(r.recencyBoost === null, 'No temporal → recencyBoost=null');
  assert(r.dateTerms.length === 0, 'No temporal → no dateTerms');
  assert(r.strippedQuery === 'how is my bromantane protocol?', 'No temporal → query unchanged');
}

// ─── Test 7: N days ago ───
console.log('Test 7: N days ago');
{
  const r = resolveTemporalQuery('what was I doing 5 days ago?', NOW);
  assert(r.since.includes('2026-02-23'), `Expected since=2026-02-23, got ${r.since}`);
  assert(r.until.includes('2026-02-24'), `Expected until=2026-02-24, got ${r.until}`);
  assert(r.dateTerms.includes('2026-02-23'), 'Expected 2026-02-23 in dateTerms');
}

// ─── Test 8: this month ───
console.log('Test 8: this month');
{
  const r = resolveTemporalQuery('what happened this month?', NOW);
  assert(r.since.includes('2026-02-01'), `Expected since=2026-02-01, got ${r.since}`);
  assert(r.recencyBoost === 14, `Expected recencyBoost=14, got ${r.recencyBoost}`);
}

// ─── Test 9: last month ───
console.log('Test 9: last month');
{
  const r = resolveTemporalQuery('what did we ship last month?', NOW);
  assert(r.since.includes('2026-01-01'), `Expected since=2026-01-01, got ${r.since}`);
  assert(r.until.includes('2026-02-01'), `Expected until=2026-02-01, got ${r.until}`);
  assert(r.recencyBoost === 30, `Expected recencyBoost=30, got ${r.recencyBoost}`);
}

// ─── Test 10: this morning ───
console.log('Test 10: this morning');
{
  const r = resolveTemporalQuery('what did I log this morning?', NOW);
  assert(r.since.includes('2026-02-28'), 'this morning should resolve to today');
  assert(r.dateTerms.includes('2026-02-28'), 'Expected today in dateTerms');
}

// ─── Test 11: Attribution query — entity + speech verb ───
console.log('Test 11: Attribution query — entity + speech verb');
{
  const entities = new Set(['ali', 'tom', 'joe']);
  const r = isAttributionQuery('What did Ali say about the restructuring?', entities);
  assert(r.isAttribution === true, 'Should detect attribution');
  assert(r.entity === 'ali', `Expected entity=ali, got ${r.entity}`);
}

// ─── Test 12: Attribution query — no speech verb ───
console.log('Test 12: Attribution query — no speech verb');
{
  const entities = new Set(['ali', 'tom']);
  const r = isAttributionQuery('What is Ali working on?', entities);
  assert(r.isAttribution === false, 'No speech verb → not attribution');
}

// ─── Test 13: Attribution query — speech verb but no entity ───
console.log('Test 13: Attribution query — speech verb but no entity');
{
  const entities = new Set(['ali', 'tom']);
  const r = isAttributionQuery('Who said something about the budget?', entities);
  assert(r.isAttribution === false, 'No entity match → not attribution');
}

// ─── Test 14: Attribution query — various speech verbs ───
console.log('Test 14: Attribution query — various speech verbs');
{
  const entities = new Set(['tom']);
  assert(isAttributionQuery('Tom mentioned the deadline', entities).isAttribution, 'mentioned');
  assert(isAttributionQuery('What did Tom suggest?', entities).isAttribution, 'suggested');
  assert(isAttributionQuery('Tom told me about the plan', entities).isAttribution, 'told');
  assert(isAttributionQuery('Tom discussed it', entities).isAttribution, 'discussed');
}

// ─── Test 15: Temporal integration — yesterday filters results ───
console.log('Test 15: Temporal integration — yesterday filters results');
{
  const db = createDb();
  const yesterday = new Date(NOW);
  yesterday.setDate(yesterday.getDate() - 1);
  const oldDate = new Date(NOW);
  oldDate.setDate(oldDate.getDate() - 30);

  insertChunk(db, {
    content: 'deployed new SME version to production 2026-02-27',
    filePath: 'memory/2026-02-27.md',
    createdAt: yesterday.toISOString(),
  });
  insertChunk(db, {
    content: 'deployed infrastructure changes to production servers',
    filePath: 'memory/2026-01-29.md',
    createdAt: oldDate.toISOString(),
  });

  const result = getRelevantContext(db, 'what did I deploy yesterday?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  if (result.chunks.length > 0) {
    assert(result.chunks[0].filePath.includes('2026-02-27'), `Expected yesterday's file ranked first, got ${result.chunks[0].filePath}`);
  }
  db.close();
}

// ─── Test 16: Attribution lifts exclusions for transcripts ───
console.log('Test 16: Attribution lifts exclusions for transcripts');
{
  invalidateEntityCache();
  const db = createDb();
  const now = new Date().toISOString();

  insertChunk(db, {
    content: 'Ali said restructuring will happen in March with new teams being formed',
    filePath: 'data/gauntlet/transcripts/2026-02-13_All_Hands.md',
    createdAt: now,
    entities: JSON.stringify(['Ali']),
  });
  insertChunk(db, {
    content: 'Movement team restructuring summary and new allocation plan',
    filePath: 'memory/2026-02-20.md',
    createdAt: now,
    entities: JSON.stringify(['Ali']),
  });

  // Non-attribution query — transcript should be excluded
  const nonAttrib = getRelevantContext(db, 'restructuring team allocation plan', {
    excludeFromRecall: ['data/gauntlet/transcripts/*.md'],
    alwaysExclude: [],
  });
  const hasTranscriptExcluded = nonAttrib.chunks.some(c => c.filePath.includes('gauntlet'));
  assert(!hasTranscriptExcluded, 'Non-attribution query should exclude transcripts');

  // Attribution query with excludeFromRecall — should LIFT transcript exclusions
  const withAttribution = getRelevantContext(db, 'What did Ali say about restructuring?', {
    excludeFromRecall: ['data/gauntlet/transcripts/*.md'],
    alwaysExclude: ['SOUL.md'],
  });
  const transcriptFound = withAttribution.chunks.some(c => c.filePath.includes('gauntlet'));
  assert(transcriptFound, 'Attribution query should lift transcript exclusions');

  // alwaysExclude should still be enforced even for attribution queries
  insertChunk(db, {
    content: 'Ali restructuring notes soul document internal reference',
    filePath: 'SOUL.md',
    createdAt: now,
    entities: JSON.stringify(['Ali']),
  });
  const withAlways = getRelevantContext(db, 'What did Ali say about restructuring?', {
    excludeFromRecall: ['data/gauntlet/transcripts/*.md'],
    alwaysExclude: ['SOUL.md'],
  });
  const hasSoul = withAlways.chunks.some(c => c.filePath === 'SOUL.md');
  assert(!hasSoul, 'alwaysExclude should still exclude SOUL.md even for attribution');

  db.close();
}

// ─── Test 17: Non-attribution keeps exclusions ───
console.log('Test 17: Non-attribution keeps exclusions');
{
  invalidateEntityCache();
  const db = createDb();
  const now = new Date().toISOString();

  insertChunk(db, {
    content: 'bromantane dopamine protocol daily morning supplement nootropic',
    filePath: 'data/gauntlet/transcripts/2026-02-10.md',
    createdAt: now,
  });
  insertChunk(db, {
    content: 'bromantane protocol started daily 5mg morning dose nootropic',
    filePath: 'memory/2026-02-20.md',
    createdAt: now,
  });

  const result = getRelevantContext(db, 'how is my bromantane protocol?', {
    excludeFromRecall: ['data/gauntlet/transcripts/*.md'],
    alwaysExclude: [],
  });
  const hasTranscript = result.chunks.some(c => c.filePath.includes('gauntlet'));
  assert(!hasTranscript, 'Non-attribution query should keep transcript exclusions');
  db.close();
}

// ─── Test 18: Temporal + content query ───
console.log('Test 18: Temporal + content query combination');
{
  const r = resolveTemporalQuery('how did my creatine experiment go this week?', NOW);
  assert(r.since !== null, 'this week should set since');
  assert(r.recencyBoost === 7, 'this week should set recencyBoost=7');
  assert(r.strippedQuery.includes('creatine'), 'Content words should survive stripping');
  assert(!r.strippedQuery.includes('this week'), 'Temporal phrase should be stripped');
}

// ─── Test 19: Day-of-week — "on wednesday" ───
console.log('Test 19: Day-of-week — on wednesday');
{
  // NOW = Feb 28 2026 (Saturday). Most recent Wednesday = Feb 25.
  const r = resolveTemporalQuery('what happened on wednesday?', NOW);
  assert(r.since.includes('2026-02-25'), `Expected since=2026-02-25, got ${r.since}`);
  assert(r.until.includes('2026-02-26'), `Expected until=2026-02-26, got ${r.until}`);
  assert(r.dateTerms.includes('2026-02-25'), 'Expected 2026-02-25 in dateTerms');
  assert(!r.strippedQuery.includes('wednesday'), 'wednesday should be stripped');
}

// ─── Test 20: Last day-of-week — "last monday" ───
console.log('Test 20: Last day-of-week — last monday');
{
  // NOW = Feb 28 (Saturday). Most recent Monday = Feb 23 (5 days back).
  const r = resolveTemporalQuery('what did I do last monday?', NOW);
  assert(r.since.includes('2026-02-23'), `Expected since=2026-02-23, got ${r.since}`);
  assert(r.until.includes('2026-02-24'), `Expected until=2026-02-24, got ${r.until}`);
  assert(r.dateTerms.includes('2026-02-23'), 'Expected 2026-02-23 in dateTerms');
  assert(!r.strippedQuery.includes('last monday'), 'last monday should be stripped');
}

// ─── Test 21: Named month — "in january" ───
console.log('Test 21: Named month — in january');
{
  // NOW = Feb 2026. January is past → use 2026.
  const r = resolveTemporalQuery('what happened in january?', NOW);
  assert(r.since.includes('2026-01-01'), `Expected since=2026-01-01, got ${r.since}`);
  assert(r.until.includes('2026-02-01'), `Expected until=2026-02-01, got ${r.until}`);
  assert(r.recencyBoost === 30, `Expected recencyBoost=30, got ${r.recencyBoost}`);
  assert(!r.strippedQuery.includes('january'), 'in january should be stripped');
}

// ─── Test 22: Named month future → previous year ───
console.log('Test 22: Named month future resolves to previous year');
{
  // NOW = Feb 2026. March hasn't happened yet → use 2025.
  const r = resolveTemporalQuery('what did we do in march?', NOW);
  assert(r.since.includes('2025-03-01'), `Expected since=2025-03-01, got ${r.since}`);
  assert(r.until.includes('2025-04-01'), `Expected until=2025-04-01, got ${r.until}`);
}

// ─── Test 23: Next month ───
console.log('Test 23: Next month');
{
  // NOW = Feb 2026 → next month = March 2026.
  const r = resolveTemporalQuery('what is planned for next month?', NOW);
  assert(r.since.includes('2026-03-01'), `Expected since=2026-03-01, got ${r.since}`);
  assert(r.until.includes('2026-04-01'), `Expected until=2026-04-01, got ${r.until}`);
  assert(r.recencyBoost === 30, `Expected recencyBoost=30, got ${r.recencyBoost}`);
  assert(!r.strippedQuery.includes('next month'), 'next month should be stripped');
}

// ─── Test 24: Last few days ───
console.log('Test 24: Last few days');
{
  // NOW = Feb 28 → 3 days ago = Feb 25.
  const r = resolveTemporalQuery('what happened in the last few days?', NOW);
  assert(r.since.includes('2026-02-25'), `Expected since=2026-02-25, got ${r.since}`);
  assert(r.recencyBoost === 7, `Expected recencyBoost=7, got ${r.recencyBoost}`);
  assert(!r.strippedQuery.includes('last few days'), 'last few days should be stripped');
}

// ─── Test 25: Day-of-week stripping preserves content ───
console.log('Test 25: Day-of-week stripping preserves content');
{
  const r = resolveTemporalQuery('meeting notes from last monday', NOW);
  assert(!r.strippedQuery.includes('monday'), 'monday should be stripped');
  assert(r.strippedQuery.includes('meeting notes'), 'content words should survive');
}

// ─── Test 26: Bare day name ───
console.log('Test 26: Bare day name — friday');
{
  // NOW = Feb 28 (Saturday). Most recent Friday = Feb 27 (1 day back).
  const r = resolveTemporalQuery('what happened friday?', NOW);
  assert(r.since.includes('2026-02-27'), `Expected since=2026-02-27, got ${r.since}`);
  assert(r.until.includes('2026-02-28'), `Expected until=2026-02-28, got ${r.until}`);
  assert(r.dateTerms.includes('2026-02-27'), 'Expected 2026-02-27 in dateTerms');
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
