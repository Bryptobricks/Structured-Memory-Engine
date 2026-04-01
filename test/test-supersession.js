#!/usr/bin/env node
/**
 * Tests for detectSuperseded() — v9 restructuring.
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { detectSuperseded } = require('../lib/reflect');

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

function insertChunk(db, content, entities, type, confidence, createdAt, filePath) {
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, stale)
    VALUES (?, ?, ?, 1, 10, ?, ?, ?, ?, ?, 0)`).run(
    filePath || 'memory/2026-03-01.md', 'Test', content, JSON.stringify(entities), type || 'fact', confidence || 1.0, createdAt || '2026-03-01T00:00:00.000Z', new Date().toISOString()
  );
}

// --- Weight change supersession ---

console.log('Test 1: Weight update — older superseded by newer');
{
  const db = createDb();
  insertChunk(db, 'JB weighs 200 lbs, measured this morning', ['JB'], 'fact', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'JB weighs 197 lbs, measured this morning', ['JB'], 'fact', 1.0, '2026-03-20T00:00:00.000Z');

  const result = detectSuperseded(db);
  assert(result.duplicates.length >= 1, `Expected duplicate (high sim), got ${result.duplicates.length} dupes, ${result.superseded.length} superseded`);
  assert(result.total >= 1, `Expected at least 1 total, got ${result.total}`);

  // Verify older chunk is now outdated
  const older = db.prepare('SELECT chunk_type FROM chunks ORDER BY created_at ASC LIMIT 1').get();
  assert(older.chunk_type === 'outdated', `Older should be outdated, got ${older.chunk_type}`);
}

// --- Negation supersession ---

console.log('Test 2: Negation — "no longer likes blue"');
{
  const db = createDb();
  // Use content different enough to avoid duplicate threshold (sim < 0.7) but similar enough for supersession
  insertChunk(db, 'JB prefers blue themes', ['JB'], 'preference', 1.0, '2026-02-01T00:00:00.000Z');
  insertChunk(db, 'JB no longer prefers blue themes, switched to dark', ['JB'], 'preference', 1.0, '2026-03-15T00:00:00.000Z');

  const result = detectSuperseded(db);
  assert(result.total >= 1, `Expected supersession or duplicate, got ${result.total}`);

  const older = db.prepare('SELECT chunk_type FROM chunks ORDER BY created_at ASC LIMIT 1').get();
  assert(older.chunk_type === 'outdated', `Older should be outdated, got ${older.chunk_type}`);
}

// --- Different topics — no supersession ---

console.log('Test 3: Different topics — no supersession');
{
  const db = createDb();
  insertChunk(db, 'JB has a Tesla Model 3', ['JB', 'Tesla'], 'fact', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'JB likes pepperoni pizza for dinner', ['JB'], 'fact', 1.0, '2026-03-15T00:00:00.000Z');

  const result = detectSuperseded(db);
  assert(result.total === 0, `Expected 0 supersessions, got ${result.total}`);
}

// --- Dry run — no mutations ---

console.log('Test 4: Dry run — reports but does not mutate');
{
  const db = createDb();
  insertChunk(db, 'JB weighs 200 lbs, checked at gym', ['JB'], 'fact', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'JB weighs 197 lbs, checked at gym', ['JB'], 'fact', 1.0, '2026-03-20T00:00:00.000Z');

  const result = detectSuperseded(db, { dryRun: true });
  assert(result.total >= 1, `Expected at least 1 in dry run, got ${result.total}`);

  // Verify NO mutations
  const types = db.prepare('SELECT chunk_type FROM chunks').all().map(r => r.chunk_type);
  assert(!types.includes('outdated'), `Dry run should not mutate, but found outdated`);
}

// --- Non-supersedable types ignored ---

console.log('Test 5: Decision type — not superseded');
{
  const db = createDb();
  insertChunk(db, 'JB decided to use React for the project', ['JB', 'React'], 'decision', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'JB decided to use Vue for the project', ['JB', 'Vue'], 'decision', 1.0, '2026-03-15T00:00:00.000Z');

  const result = detectSuperseded(db);
  assert(result.total === 0, `Decision type should not be superseded, got ${result.total}`);
}

// --- Recency window ---

console.log('Test 6: Outside recency window — not compared');
{
  const db = createDb();
  insertChunk(db, 'JB weighs 200 lbs, gym measurement', ['JB'], 'fact', 1.0, '2025-01-01T00:00:00.000Z');
  insertChunk(db, 'JB weighs 197 lbs, gym measurement', ['JB'], 'fact', 1.0, '2026-03-20T00:00:00.000Z');

  const result = detectSuperseded(db, { recencyWindowDays: 90 });
  assert(result.total === 0, `Outside 90-day window should not compare, got ${result.total}`);
}

// --- Refinement (higher confidence) ---

console.log('Test 7: Higher confidence supersedes lower');
{
  const db = createDb();
  insertChunk(db, 'JB started taking supplements daily routine', ['JB'], 'fact', 0.5, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'JB started taking supplements daily routine confirmed', ['JB'], 'fact', 1.0, '2026-03-10T00:00:00.000Z');

  const result = detectSuperseded(db);
  assert(result.total >= 1, `Expected supersession by confidence, got ${result.total}`);
}

// --- No shared entity — no supersession ---

console.log('Test 8: No shared entity — no comparison');
{
  const db = createDb();
  insertChunk(db, 'Apple released a new MacBook model today', ['Apple', 'MacBook'], 'fact', 1.0, '2026-03-01T00:00:00.000Z');
  insertChunk(db, 'Tesla announced their latest autopilot update', ['Tesla'], 'fact', 1.0, '2026-03-15T00:00:00.000Z');

  const result = detectSuperseded(db);
  assert(result.total === 0, `No shared entity, got ${result.total}`);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
