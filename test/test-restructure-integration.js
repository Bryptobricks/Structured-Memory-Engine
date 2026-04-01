#!/usr/bin/env node
/**
 * Integration test — restructure step runs within full reflect cycle.
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { runReflectCycle } = require('../lib/reflect');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE chunks ADD COLUMN file_weight REAL DEFAULT 1.0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN last_accessed TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN stale INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN value_score REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN value_label TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN content_updated_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN source_type TEXT DEFAULT \'indexed\''); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN domain TEXT DEFAULT \'general\''); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN priority TEXT DEFAULT \'medium\''); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN referenced_date TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN relative_offset REAL'); } catch (_) {}
  return db;
}

function insertChunk(db, content, entities, type, confidence, createdAt) {
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, stale)
    VALUES (?, ?, ?, 1, 10, ?, ?, ?, ?, ?, 0)`).run(
    'memory/2026-03-01.md', 'Test', content, JSON.stringify(entities), type || 'fact', confidence || 1.0, createdAt || '2026-03-01T00:00:00.000Z', new Date().toISOString()
  );
}

// --- Full reflect cycle includes restructure ---

console.log('Test 1: Reflect cycle includes restructure result');
{
  const db = createDb();
  insertChunk(db, 'JB weighs 200 lbs morning weigh-in', ['JB'], 'fact', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'JB weighs 197 lbs morning weigh-in', ['JB'], 'fact', 1.0, '2026-03-20T00:00:00.000Z');

  const result = runReflectCycle(db);
  assert(result.restructure !== undefined, 'Result should include restructure');
  assert(result.restructure.total >= 1, `Expected restructure to find supersessions, got ${result.restructure.total}`);
}

// --- Dry run mode ---

console.log('Test 2: Shadow mode — restructure runs but no mutations');
{
  const db = createDb();
  insertChunk(db, 'JB takes creatine 5g daily supplement', ['JB'], 'fact', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'JB no longer takes creatine 5g daily supplement', ['JB'], 'fact', 1.0, '2026-03-15T00:00:00.000Z');

  const result = runReflectCycle(db, { dryRun: true });
  assert(result.restructure.total >= 1, `Should find supersessions in dry run, got ${result.restructure.total}`);

  const types = db.prepare('SELECT chunk_type FROM chunks').all().map(r => r.chunk_type);
  assert(!types.includes('outdated'), 'Dry run should not mutate chunks');
}

// --- Superseded chunks become outdated and decay faster ---

console.log('Test 3: Superseded chunks get outdated type');
{
  const db = createDb();
  insertChunk(db, 'JB prefers dark roast coffee every morning', ['JB'], 'preference', 1.0, '2026-02-01T00:00:00.000Z');
  insertChunk(db, 'JB no longer prefers dark roast coffee every morning', ['JB'], 'preference', 1.0, '2026-03-01T00:00:00.000Z');

  runReflectCycle(db);

  const older = db.prepare('SELECT chunk_type FROM chunks ORDER BY created_at ASC LIMIT 1').get();
  assert(older.chunk_type === 'outdated', `Superseded chunk should be outdated, got ${older.chunk_type}`);
}

// --- No supersedable chunks — restructure returns empty ---

console.log('Test 4: No supersedable chunks — clean result');
{
  const db = createDb();
  insertChunk(db, 'decided to use React for the frontend build', ['React'], 'decision', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'the API uses Express with middleware', ['Express'], 'confirmed', 1.0, '2026-03-15T00:00:00.000Z');

  const result = runReflectCycle(db);
  assert(result.restructure.total === 0, `Expected 0 restructure results, got ${result.restructure.total}`);
}

// --- Restructure runs in correct order (after contradictions, before prune) ---

console.log('Test 5: Reflect cycle order preserved');
{
  const db = createDb();
  const result = runReflectCycle(db);
  // Verify all expected keys present
  const keys = Object.keys(result);
  assert(keys.includes('decay'), 'Should include decay');
  assert(keys.includes('contradictions'), 'Should include contradictions');
  assert(keys.includes('restructure'), 'Should include restructure');
  assert(keys.includes('prune'), 'Should include prune');
  // Verify restructure comes after contradictions in key order
  const cIdx = keys.indexOf('contradictions');
  const rIdx = keys.indexOf('restructure');
  const pIdx = keys.indexOf('prune');
  assert(rIdx > cIdx, `restructure (${rIdx}) should come after contradictions (${cIdx})`);
  assert(rIdx < pIdx, `restructure (${rIdx}) should come before prune (${pIdx})`);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
