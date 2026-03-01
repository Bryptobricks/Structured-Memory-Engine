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
  // Use real system clock so getRelevantContext (which uses real Date) matches fixtures
  const realNow = new Date();
  const yesterday = new Date(realNow);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const oldDate = new Date(realNow);
  oldDate.setDate(oldDate.getDate() - 30);
  const oldDateStr = oldDate.toISOString().split('T')[0];

  insertChunk(db, {
    content: `deployed new SME version to production ${yesterdayStr}`,
    filePath: `memory/${yesterdayStr}.md`,
    createdAt: yesterday.toISOString(),
  });
  insertChunk(db, {
    content: 'deployed infrastructure changes to production servers',
    filePath: `memory/${oldDateStr}.md`,
    createdAt: oldDate.toISOString(),
  });

  const result = getRelevantContext(db, 'what did I deploy yesterday?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  if (result.chunks.length > 0) {
    assert(result.chunks[0].filePath.includes(yesterdayStr), `Expected yesterday's file ranked first, got ${result.chunks[0].filePath}`);
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

// ─── Test 22: Named month — always current year ───
console.log('Test 22: Named month — always current year');
{
  // NOW = Feb 2026. "in march" → March 2026 (current year, even though future).
  const r = resolveTemporalQuery('what did we do in march?', NOW);
  assert(r.since.includes('2026-03-01'), `Expected since=2026-03-01, got ${r.since}`);
  assert(r.until.includes('2026-04-01'), `Expected until=2026-04-01, got ${r.until}`);
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

// ─── Test 27: Compound — "wednesday of last week" ───
console.log('Test 27: Compound — wednesday of last week');
{
  // NOW = Feb 28 (Saturday). Last week = Feb 15-21. Wednesday of last week = Feb 18.
  const r = resolveTemporalQuery('What did I accomplish on Wednesday of last week?', NOW);
  assert(r.since.includes('2026-02-18'), `Expected since=2026-02-18, got ${r.since}`);
  assert(r.until.includes('2026-02-19'), `Expected until=2026-02-19, got ${r.until}`);
  assert(r.dateTerms.includes('2026-02-18'), 'Expected 2026-02-18 in dateTerms');
  assert(!r.strippedQuery.includes('Wednesday'), 'wednesday should be stripped');
  assert(!r.strippedQuery.includes('last week'), 'last week should be stripped');
}

// ─── Test 28: Compound — "last week's friday" ───
console.log('Test 28: Compound — last week\'s friday');
{
  // NOW = Feb 28 (Saturday). Last week = Feb 15-21. Friday of last week = Feb 20.
  const r = resolveTemporalQuery("What happened last week's friday?", NOW);
  assert(r.since.includes('2026-02-20'), `Expected since=2026-02-20, got ${r.since}`);
  assert(r.until.includes('2026-02-21'), `Expected until=2026-02-21, got ${r.until}`);
  assert(r.dateTerms.includes('2026-02-20'), 'Expected 2026-02-20 in dateTerms');
}

// ─── Test 29: Compound — "wednesday of this last week" ───
console.log('Test 29: Compound — wednesday of this last week');
{
  // "this last week" variant should resolve same as "last week"
  const r = resolveTemporalQuery('What did I do Wednesday of this last week?', NOW);
  assert(r.since.includes('2026-02-18'), `Expected since=2026-02-18, got ${r.since}`);
  assert(r.dateTerms.includes('2026-02-18'), 'Expected 2026-02-18 in dateTerms');
}

// ─── Test 30: Bare "last week" unaffected by compound pattern ───
console.log('Test 30: Bare last week still works as range');
{
  const r = resolveTemporalQuery('what did we do last week?', NOW);
  assert(r.since !== null, 'last week should set since');
  assert(r.until !== null, 'last week should set until');
  assert(r.recencyBoost === 14, `Expected recencyBoost=14, got ${r.recencyBoost}`);
  assert(r.dateTerms.length === 0, 'Bare last week should have no dateTerms');
}

// ─── Test 31: Next week ───
console.log('Test 31: Next week');
{
  // NOW = Feb 28 (Saturday). Next week starts Sunday Mar 1.
  const r = resolveTemporalQuery('what are my plans for next week?', NOW);
  assert(r.since.includes('2026-03-01'), `Expected since=2026-03-01, got ${r.since}`);
  assert(r.until.includes('2026-03-08'), `Expected until=2026-03-08, got ${r.until}`);
  assert(r.recencyBoost === 14, `Expected recencyBoost=14, got ${r.recencyBoost}`);
  assert(r.forwardLooking === true, 'next week should set forwardLooking=true');
  assert(!r.strippedQuery.includes('next week'), 'next week should be stripped');
}

// ─── Test 32: Forward-looking flag — next month ───
console.log('Test 32: Forward-looking flag — next month');
{
  const r = resolveTemporalQuery('what is scheduled for next month?', NOW);
  assert(r.forwardLooking === true, 'next month should set forwardLooking=true');
}

// ─── Test 33: Forward-looking flag — plan keywords ───
console.log('Test 33: Forward-looking flag — plan keywords');
{
  const r = resolveTemporalQuery('what are my goals for this quarter?', NOW);
  assert(r.forwardLooking === true, 'goals keyword should set forwardLooking=true');
}

// ─── Test 34: Forward-looking flag — no forward intent ───
console.log('Test 34: No forward-looking flag for backward queries');
{
  const r = resolveTemporalQuery('what happened yesterday?', NOW);
  assert(r.forwardLooking === false, 'yesterday should not set forwardLooking');
}

// ─── Test 35: Forward-looking — action keywords ───
console.log('Test 35: Forward-looking — deadline/schedule keywords');
{
  const r1 = resolveTemporalQuery('what deadlines do I have?', NOW);
  assert(r1.forwardLooking === true, 'deadline should set forwardLooking');
  const r2 = resolveTemporalQuery('what is upcoming?', NOW);
  assert(r2.forwardLooking === true, 'upcoming should set forwardLooking');
  const r3 = resolveTemporalQuery('what is on my todo?', NOW);
  assert(r3.forwardLooking === true, 'todo should set forwardLooking');
}

// ─── Test 36: Future named month sets forwardLooking + forwardTerms ───
console.log('Test 36: Future named month — forwardLooking and forwardTerms');
{
  // NOW = Feb 28. March is in the future.
  const r = resolveTemporalQuery("What's coming up for me in March?", NOW);
  assert(r.forwardLooking === true, 'future named month should set forwardLooking=true');
  assert(Array.isArray(r.forwardTerms), 'forwardTerms should be an array');
  assert(r.forwardTerms.includes('march'), `forwardTerms should contain 'march', got ${JSON.stringify(r.forwardTerms)}`);
  assert(r.since.includes('2026-03-01'), `Expected since=2026-03-01, got ${r.since}`);
}

// ─── Test 37: Past named month does NOT set forwardTerms ───
console.log('Test 37: Past named month — no forwardTerms');
{
  // NOW = Feb 28. January is in the past.
  const r = resolveTemporalQuery('What happened in January?', NOW);
  assert(r.forwardLooking === false, 'past named month should not set forwardLooking');
  assert(r.forwardTerms.length === 0, `forwardTerms should be empty for past month, got ${JSON.stringify(r.forwardTerms)}`);
}

// ─── Test 38: "coming up" sets forwardLooking ───
console.log('Test 38: "coming up" sets forwardLooking');
{
  const r = resolveTemporalQuery("What's coming up for me?", NOW);
  assert(r.forwardLooking === true, '"coming up" should set forwardLooking=true');
}

// ─── Test 39: forwardTerms always present in return value ───
console.log('Test 39: forwardTerms always present in return value');
{
  const r = resolveTemporalQuery('what happened yesterday?', NOW);
  assert(Array.isArray(r.forwardTerms), 'forwardTerms should always be an array');
  assert(r.forwardTerms.length === 0, 'forwardTerms should be empty for backward queries');
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
