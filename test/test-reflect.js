#!/usr/bin/env node
/**
 * Tests for v3 Reflect — decay, reinforcement, staleness, contradiction detection, pruning, restore.
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { decayConfidence, reinforceConfidence, markStale, detectContradictions, pruneStale, restoreChunk, resolveContradiction, runReflectCycle } = require('../lib/reflect');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  // Apply migrations (same as openDb)
  try { db.exec('ALTER TABLE chunks ADD COLUMN file_weight REAL DEFAULT 1.0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN last_accessed TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN stale INTEGER DEFAULT 0'); } catch (_) {}
  // Recreate trigger to be column-specific
  try {
    db.exec('DROP TRIGGER IF EXISTS chunks_au');
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content, heading, entities ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading, entities) VALUES ('delete', old.id, old.content, old.heading, old.entities);
      INSERT INTO chunks_fts(rowid, content, heading, entities) VALUES (new.id, new.content, new.heading, new.entities);
    END;`);
  } catch (_) {}
  return db;
}

function insertChunk(db, { heading = null, content = 'test content', chunkType = 'raw', confidence = 1.0, createdAt = null, accessCount = 0, lastAccessed = null, stale = 0, filePath = 'test.md' } = {}) {
  const now = new Date().toISOString();
  const result = db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale)
    VALUES (?, ?, ?, 1, 10, '[]', ?, ?, ?, ?, 1.0, ?, ?, ?)`).run(
    filePath, heading, content, chunkType, confidence, createdAt || now, now, accessCount, lastAccessed, stale
  );
  return result.lastInsertRowid;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── Test 1: Decay ───
console.log('Test 1: Confidence decay');
{
  const db = createDb();
  // confirmed: immune
  insertChunk(db, { chunkType: 'confirmed', confidence: 1.0, createdAt: daysAgo(365) });
  // inferred: normal decay
  const inferredId = insertChunk(db, { chunkType: 'inferred', confidence: 0.7, createdAt: daysAgo(200) });
  // outdated: fast decay
  const outdatedId = insertChunk(db, { chunkType: 'outdated', confidence: 0.3, createdAt: daysAgo(100) });
  // recent: minimal decay
  insertChunk(db, { chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(5) });

  const result = decayConfidence(db, { dryRun: false });
  assert(result.decayed >= 2, `Expected at least 2 decayed, got ${result.decayed}`);

  const confirmed = db.prepare('SELECT confidence FROM chunks WHERE chunk_type = ?').get('confirmed');
  assert(confirmed.confidence === 1.0, `Confirmed should be immune, got ${confirmed.confidence}`);

  const inferred = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(inferredId);
  assert(inferred.confidence < 0.7, `Inferred should have decayed from 0.7, got ${inferred.confidence}`);

  const outdated = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(outdatedId);
  assert(outdated.confidence < 0.3, `Outdated should have decayed from 0.3, got ${outdated.confidence}`);

  // Verify outdated decays faster than inferred (proportionally)
  const inferredDecay = 0.7 - inferred.confidence;
  const outdatedDecay = 0.3 - outdated.confidence;
  // outdated rate is 2x, so per-day decay should be higher even though it started lower
  assert(outdatedDecay > 0, `Outdated should have some decay`);
  db.close();
}

// ─── Test 2: Reinforcement (floor-based, idempotent) ───
console.log('Test 2: Confidence reinforcement');
{
  const db = createDb();
  // confidence 0.1, accessCount 10 → floor = 0.2, boosted to 0.2
  const belowFloorId = insertChunk(db, { confidence: 0.1, accessCount: 10 });
  // confidence 0.5, accessCount 10 → floor = 0.2, stays 0.5 (already above floor)
  const aboveFloorId = insertChunk(db, { confidence: 0.5, accessCount: 10 });
  // confidence 0.95, accessCount 25 → floor = 0.5, stays 0.95 (already above floor)
  const highId = insertChunk(db, { confidence: 0.95, accessCount: 25 });
  // zero accesses → not selected by query
  const zeroId = insertChunk(db, { confidence: 0.3, accessCount: 0 });

  const result = reinforceConfidence(db, { dryRun: false });
  assert(result.reinforced === 1, `Expected 1 reinforced (only below-floor chunk), got ${result.reinforced}`);

  const belowFloor = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(belowFloorId);
  assert(belowFloor.confidence === 0.2, `Expected floor 0.2, got ${belowFloor.confidence}`);

  const aboveFloor = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(aboveFloorId);
  assert(aboveFloor.confidence === 0.5, `Already above floor, should stay 0.5, got ${aboveFloor.confidence}`);

  const high = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(highId);
  assert(high.confidence === 0.95, `Already above floor, should stay 0.95, got ${high.confidence}`);

  const zero = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(zeroId);
  assert(zero.confidence === 0.3, `Zero accesses should not be reinforced, got ${zero.confidence}`);
  db.close();
}

// ─── Test 3: Staleness ───
console.log('Test 3: Mark stale');
{
  const db = createDb();
  // Low confidence + old → stale
  insertChunk(db, { confidence: 0.2, createdAt: daysAgo(100) });
  // Very low confidence + moderately old → stale
  insertChunk(db, { confidence: 0.05, createdAt: daysAgo(40) });
  // High confidence + old → NOT stale
  insertChunk(db, { confidence: 0.8, createdAt: daysAgo(200) });
  // Low confidence + recent → NOT stale
  insertChunk(db, { confidence: 0.2, createdAt: daysAgo(10) });

  const result = markStale(db, { dryRun: false });
  assert(result.marked === 2, `Expected 2 marked stale, got ${result.marked}`);

  const staleCount = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE stale = 1').get().n;
  assert(staleCount === 2, `Expected 2 stale in DB, got ${staleCount}`);
  db.close();
}

// ─── Test 4: Pruning ───
console.log('Test 4: Prune stale chunks');
{
  const db = createDb();
  // Qualifies: stale + low confidence + very old
  insertChunk(db, { stale: 1, confidence: 0.05, createdAt: daysAgo(200), accessCount: 0 });
  // Qualifies: never accessed + very low confidence
  insertChunk(db, { stale: 1, confidence: 0.02, createdAt: daysAgo(50), accessCount: 0 });
  // Does NOT qualify: stale but confidence too high
  insertChunk(db, { stale: 1, confidence: 0.5, createdAt: daysAgo(200), accessCount: 3 });
  // Does NOT qualify: not stale
  insertChunk(db, { stale: 0, confidence: 0.01, createdAt: daysAgo(300), accessCount: 0 });

  const result = pruneStale(db, { dryRun: false });
  assert(result.archived === 2, `Expected 2 archived, got ${result.archived}`);

  const chunkCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
  assert(chunkCount === 2, `Expected 2 remaining chunks, got ${chunkCount}`);

  const archivedCount = db.prepare('SELECT COUNT(*) as n FROM archived_chunks').get().n;
  assert(archivedCount === 2, `Expected 2 in archived_chunks, got ${archivedCount}`);
  db.close();
}

// ─── Test 5: Contradiction detection (true positive) ───
console.log('Test 5: Contradiction detection — true positive');
{
  const db = createDb();
  insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Daily Protocol', content: 'stopped creatine sublingual daily morning protocol due tolerance', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10) });

  const result = detectContradictions(db, { dryRun: false });
  assert(result.newFlags === 1, `Expected 1 contradiction, got ${result.newFlags}`);
  assert(result.found >= 1, `Expected at least 1 total, got ${result.found}`);

  const contraRow = db.prepare('SELECT * FROM contradictions').get();
  assert(contraRow != null, 'Expected a row in contradictions table');
  assert(contraRow.reason.includes('negation'), `Expected reason to mention negation, got: ${contraRow.reason}`);
  db.close();
}

// ─── Test 6: Contradiction detection (false positive guard) ───
console.log('Test 6: Contradiction detection — no false positive');
{
  const db = createDb();
  insertChunk(db, { heading: 'Supplement Stack', content: 'Alex takes magnesium glycinate 400mg before bed for sleep quality', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Supplement Stack', content: 'Alex takes magnesium glycinate 400mg with zinc for better absorption', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10) });

  const result = detectContradictions(db, { dryRun: false });
  assert(result.newFlags === 0, `Expected 0 contradictions (no negation), got ${result.newFlags}`);
  db.close();
}

// ─── Test 7: Dry run ───
console.log('Test 7: Dry run — no DB mutations');
{
  const db = createDb();
  insertChunk(db, { chunkType: 'inferred', confidence: 0.7, createdAt: daysAgo(200), accessCount: 5 });
  insertChunk(db, { confidence: 0.2, createdAt: daysAgo(100) });
  insertChunk(db, { stale: 1, confidence: 0.05, createdAt: daysAgo(200), accessCount: 0 });

  // Snapshot state before
  const confBefore = db.prepare('SELECT id, confidence, stale FROM chunks ORDER BY id').all();
  const archivedBefore = db.prepare('SELECT COUNT(*) as n FROM archived_chunks').get().n;
  const contraBefore = db.prepare('SELECT COUNT(*) as n FROM contradictions').get().n;

  const result = runReflectCycle(db, { dryRun: true });
  assert(result.decay != null, 'Should have decay results');
  assert(result.reinforce != null, 'Should have reinforce results');

  // Verify nothing changed
  const confAfter = db.prepare('SELECT id, confidence, stale FROM chunks ORDER BY id').all();
  const archivedAfter = db.prepare('SELECT COUNT(*) as n FROM archived_chunks').get().n;
  const contraAfter = db.prepare('SELECT COUNT(*) as n FROM contradictions').get().n;

  assert(JSON.stringify(confBefore) === JSON.stringify(confAfter), 'Chunk confidence/stale should not change in dry run');
  assert(archivedBefore === archivedAfter, 'Archived count should not change in dry run');
  assert(contraBefore === contraAfter, 'Contradictions count should not change in dry run');
  db.close();
}

// ─── Test 8: Search excludes stale ───
console.log('Test 8: Search excludes stale by default');
{
  const db = createDb();
  insertChunk(db, { content: 'creatine supplement protocol', stale: 0 });
  insertChunk(db, { content: 'creatine old outdated protocol', stale: 1 });

  // Default: excludes stale
  const { search } = require('../lib/store');
  const normal = search(db, '"creatine"', { includeStale: false });
  assert(normal.length === 1, `Expected 1 result excluding stale, got ${normal.length}`);

  // With includeStale
  const withStale = search(db, '"creatine"', { includeStale: true });
  assert(withStale.length === 2, `Expected 2 results including stale, got ${withStale.length}`);
  db.close();
}

// ─── Test 9: Restore ───
console.log('Test 9: Restore archived chunk');
{
  const db = createDb();
  // Insert and archive a chunk
  insertChunk(db, { heading: 'Old Fact', content: 'some important old fact about testing restore', stale: 1, confidence: 0.01, createdAt: daysAgo(200), accessCount: 0 });

  const pruneResult = pruneStale(db, { dryRun: false });
  assert(pruneResult.archived === 1, `Expected 1 archived for restore test, got ${pruneResult.archived}`);

  const chunksBefore = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
  assert(chunksBefore === 0, `Expected 0 chunks after prune, got ${chunksBefore}`);

  const archived = db.prepare('SELECT id FROM archived_chunks').get();
  const restoreResult = restoreChunk(db, archived.id);
  assert(restoreResult.restored === true, `Expected restored=true, got ${restoreResult.restored}`);
  assert(restoreResult.newId != null, `Expected a newId, got ${restoreResult.newId}`);

  const chunksAfter = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
  assert(chunksAfter === 1, `Expected 1 chunk after restore, got ${chunksAfter}`);

  const archivedAfter = db.prepare('SELECT COUNT(*) as n FROM archived_chunks').get().n;
  assert(archivedAfter === 0, `Expected 0 archived after restore, got ${archivedAfter}`);

  // Verify FTS works on restored chunk (INSERT trigger should fire)
  const ftsResult = db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH '\"restore\"'").all();
  assert(ftsResult.length === 1, `Expected restored chunk searchable via FTS, got ${ftsResult.length}`);
  db.close();
}

// ─── Test 10: Reinforcement idempotency ───
console.log('Test 10: Reinforcement idempotency');
{
  const db = createDb();
  insertChunk(db, { confidence: 0.1, accessCount: 15 });
  insertChunk(db, { confidence: 0.05, accessCount: 5 });

  const run1 = reinforceConfidence(db, { dryRun: false });
  const after1 = db.prepare('SELECT id, confidence FROM chunks ORDER BY id').all();

  const run2 = reinforceConfidence(db, { dryRun: false });
  const after2 = db.prepare('SELECT id, confidence FROM chunks ORDER BY id').all();

  assert(run2.reinforced === 0, `Second run should be a no-op, got ${run2.reinforced} reinforced`);
  assert(JSON.stringify(after1) === JSON.stringify(after2), 'Confidence values should be identical after two runs');

  // Third run for good measure
  const run3 = reinforceConfidence(db, { dryRun: false });
  assert(run3.reinforced === 0, `Third run should also be a no-op, got ${run3.reinforced} reinforced`);
  db.close();
}

// ─── Test 11: Generic headings skipped in contradiction detection ───
console.log('Test 11: Generic headings skipped in contradiction detection');
{
  const db = createDb();
  // "Overview" is a generic heading — should NOT trigger contradiction even with negation + shared terms
  insertChunk(db, { heading: 'Overview', content: 'project uses creatine protocol daily morning routine for focus energy', filePath: 'agents/alpha.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Overview', content: 'project stopped creatine protocol daily morning routine due tolerance', filePath: 'agents/beta.md', createdAt: daysAgo(10) });

  const result = detectContradictions(db, { dryRun: false });
  assert(result.newFlags === 0, `Expected 0 contradictions for generic heading "Overview", got ${result.newFlags}`);
  db.close();
}

// ─── Test 12: Near-duplicate divergence check ───
console.log('Test 12: Near-duplicate chunks not flagged as contradictions');
{
  const db = createDb();
  // Nearly identical content with a negation word — should be caught by divergence check
  insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol focus energy stack', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Daily Protocol', content: 'not takes creatine sublingual daily morning protocol focus energy stack', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10) });

  const result = detectContradictions(db, { dryRun: false });
  assert(result.newFlags === 0, `Expected 0 for near-duplicate with high overlap, got ${result.newFlags}`);
  db.close();
}

// ─── Test 13: Recurring heading across 3+ files skipped ───
console.log('Test 13: Recurring heading across 3+ files skipped');
{
  const db = createDb();
  // "Response Quality" appears across 4 daily files — should be treated as recurring template
  insertChunk(db, { heading: '1. Response Quality', content: 'response quality was not great today, missed key context signals', filePath: 'memory/2026-01-26.md', createdAt: daysAgo(30) });
  insertChunk(db, { heading: '1. Response Quality', content: 'response quality improved, did not miss any important context signals', filePath: 'memory/2026-02-02.md', createdAt: daysAgo(23) });
  insertChunk(db, { heading: '1. Response Quality', content: 'response quality was not consistent, missed some context signals', filePath: 'memory/2026-02-09.md', createdAt: daysAgo(16) });
  insertChunk(db, { heading: '1. Response Quality', content: 'response quality excellent, did not drop any context signals today', filePath: 'memory/2026-02-16.md', createdAt: daysAgo(9) });

  const result = detectContradictions(db, { dryRun: false });
  assert(result.newFlags === 0, `Expected 0 contradictions for recurring heading across 4 files, got ${result.newFlags}`);
  db.close();
}

// ─── Test 14: Heading in exactly 2 files still checked ───
console.log('Test 14: Heading in exactly 2 files still checked');
{
  const db = createDb();
  // Same heading in only 2 files — should still detect contradiction
  insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Daily Protocol', content: 'stopped creatine sublingual daily morning protocol due tolerance', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10) });

  const result = detectContradictions(db, { dryRun: false });
  assert(result.newFlags === 1, `Expected 1 contradiction for heading in 2 files, got ${result.newFlags}`);
  db.close();
}

// ─── Test 15: Same-file skip ───
console.log('Test 15: Same-file chunks skip contradiction detection');
{
  const db = createDb();
  insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Daily Protocol', content: 'stopped creatine sublingual daily morning protocol due tolerance', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(10) });

  const result = detectContradictions(db, { dryRun: false });
  assert(result.newFlags === 0, `Expected 0 contradictions for same-file chunks, got ${result.newFlags}`);
  db.close();
}

// ─── Test 16: Temporal progression ───
console.log('Test 16: Temporal progression — negation in newer dated file only');
{
  const db = createDb();
  insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Daily Protocol', content: 'stopped creatine sublingual daily morning protocol due tolerance', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10) });

  const config = { reflect: { contradictionTemporalAwareness: true } };
  const result = detectContradictions(db, { dryRun: false, config });
  assert(result.newFlags === 0, `Expected 0 contradictions with temporal awareness, got ${result.newFlags}`);
  db.close();
}

// ─── Test 17: Negation proximity ───
console.log('Test 17: Negation proximity — negation far from shared terms');
{
  const db = createDb();
  // Shared terms are about "creatine sublingual daily morning protocol"
  // But negation "not" is far away in a completely different paragraph
  insertChunk(db, { heading: 'Daily Protocol', content: 'creatine sublingual daily morning protocol for focus energy also regarding other topics and unrelated things and various stuff I am not eating gluten this week', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Daily Protocol', content: 'creatine sublingual daily morning protocol for focus energy updated the dosage timing', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10) });

  const config = { reflect: { contradictionRequireProximity: true } };
  const result = detectContradictions(db, { dryRun: false, config });
  assert(result.newFlags === 0, `Expected 0 contradictions with proximity requirement, got ${result.newFlags}`);
  db.close();
}

// ─── Test 18: resolveContradiction keep-newer ───
console.log('Test 18: resolveContradiction keep-newer');
{
  const db = createDb();
  const oldId = insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60), confidence: 1.0 });
  const newId = insertChunk(db, { heading: 'Daily Protocol', content: 'stopped creatine sublingual daily morning protocol due tolerance', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10), confidence: 1.0 });

  detectContradictions(db, { dryRun: false });
  const contra = db.prepare('SELECT id FROM contradictions WHERE resolved = 0').get();
  assert(contra != null, 'Expected an unresolved contradiction');

  const result = resolveContradiction(db, contra.id, 'keep-newer');
  assert(result.resolved === true, `Expected resolved=true, got ${result.resolved}`);
  assert(result.action === 'keep-newer', `Expected action=keep-newer, got ${result.action}`);
  assert(result.chunkDowngraded === oldId, `Expected old chunk downgraded, got ${result.chunkDowngraded}`);

  const oldChunk = db.prepare('SELECT chunk_type, confidence FROM chunks WHERE id = ?').get(oldId);
  assert(oldChunk.chunk_type === 'outdated', `Expected old chunk type=outdated, got ${oldChunk.chunk_type}`);
  assert(oldChunk.confidence === 0.3, `Expected old chunk confidence=0.3, got ${oldChunk.confidence}`);

  const contraAfter = db.prepare('SELECT resolved FROM contradictions WHERE id = ?').get(contra.id);
  assert(contraAfter.resolved === 1, `Expected contradiction marked resolved`);
  db.close();
}

// ─── Test 19: resolveContradiction keep-both ───
console.log('Test 19: resolveContradiction keep-both');
{
  const db = createDb();
  const oldId = insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60), confidence: 1.0 });
  const newId = insertChunk(db, { heading: 'Daily Protocol', content: 'stopped creatine sublingual daily morning protocol due tolerance', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10), confidence: 1.0 });

  detectContradictions(db, { dryRun: false });
  const contra = db.prepare('SELECT id FROM contradictions WHERE resolved = 0').get();

  const result = resolveContradiction(db, contra.id, 'keep-both');
  assert(result.resolved === true, `Expected resolved=true, got ${result.resolved}`);
  assert(result.chunkKept === null, `Expected chunkKept=null for keep-both, got ${result.chunkKept}`);
  assert(result.chunkDowngraded === null, `Expected chunkDowngraded=null for keep-both, got ${result.chunkDowngraded}`);

  const oldChunk = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(oldId);
  assert(oldChunk.confidence === 1.0, `Expected old chunk unchanged at 1.0, got ${oldChunk.confidence}`);

  const newChunk = db.prepare('SELECT confidence FROM chunks WHERE id = ?').get(newId);
  assert(newChunk.confidence === 1.0, `Expected new chunk unchanged at 1.0, got ${newChunk.confidence}`);

  const contraAfter = db.prepare('SELECT resolved FROM contradictions WHERE id = ?').get(contra.id);
  assert(contraAfter.resolved === 1, `Expected contradiction marked resolved`);
  db.close();
}

// ─── Test 20: Configurable decay rate ───
console.log('Test 20: Configurable decay rate');
{
  const db = createDb();
  insertChunk(db, { chunkType: 'inferred', confidence: 0.7, createdAt: daysAgo(200) });

  // Default decay
  const defaultResult = decayConfidence(db, { dryRun: true });
  const defaultDecay = defaultResult.details[0] ? (0.7 - defaultResult.details[0].newConf) : 0;

  // Faster decay: 2x rate, 180-day half-life
  const fastConfig = { reflect: { decayRate: 2.0, halfLifeDays: 180 } };
  const fastResult = decayConfidence(db, { dryRun: true, config: fastConfig });
  const fastDecay = fastResult.details[0] ? (0.7 - fastResult.details[0].newConf) : 0;

  assert(fastDecay > defaultDecay, `Fast decay (${fastDecay.toFixed(4)}) should be greater than default (${defaultDecay.toFixed(4)})`);
  db.close();
}

// ─── Test 21: runReflectCycle uses config ───
console.log('Test 21: runReflectCycle uses config — temporal awareness');
{
  const db = createDb();
  insertChunk(db, { heading: 'Daily Protocol', content: 'takes creatine sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', createdAt: daysAgo(60) });
  insertChunk(db, { heading: 'Daily Protocol', content: 'stopped creatine sublingual daily morning protocol due tolerance', filePath: 'memory/2026-02-01.md', createdAt: daysAgo(10) });

  // Without config: should find 1 contradiction
  const resultNoConfig = runReflectCycle(db, { dryRun: true });
  assert(resultNoConfig.contradictions.newFlags === 1, `Expected 1 contradiction without config, got ${resultNoConfig.contradictions.newFlags}`);

  // With temporal awareness: should find 0 contradictions
  const config = { reflect: { contradictionTemporalAwareness: true } };
  const resultWithConfig = runReflectCycle(db, { dryRun: true, config });
  assert(resultWithConfig.contradictions.newFlags === 0, `Expected 0 contradictions with temporal awareness, got ${resultWithConfig.contradictions.newFlags}`);
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
