#!/usr/bin/env node
/**
 * Tests for v8.0 Chunk Freshness Index (Item 6)
 * - content_updated_at set from file mtime
 * - Recency uses max(created, updated, accessed)
 * - Decay skips chunks updated within 14 days
 * - Null content_updated_at falls back to created_at
 */
const Database = require('better-sqlite3');
const { SCHEMA, openDb, insertChunks } = require('../lib/store');
const { score, RECALL_PROFILE } = require('../lib/scoring');
const { decayConfidence } = require('../lib/reflect');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
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
  try {
    db.exec('DROP TRIGGER IF EXISTS chunks_au');
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content, heading, entities ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading, entities) VALUES ('delete', old.id, old.content, old.heading, old.entities);
      INSERT INTO chunks_fts(rowid, content, heading, entities) VALUES (new.id, new.content, new.heading, new.entities);
    END;`);
  } catch (_) {}
  return db;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const nowMs = Date.now();

// ─── Test 1: insertChunks sets content_updated_at from mtime ───
console.log('Test 1: insertChunks sets content_updated_at from mtime');
{
  const db = createDb();
  const mtimeMs = Date.now() - 3600000; // 1 hour ago
  const chunks = [{ heading: 'Test', content: 'Test content for freshness', lineStart: 1, lineEnd: 5, entities: [] }];
  insertChunks(db, 'test.md', mtimeMs, chunks);
  const row = db.prepare('SELECT content_updated_at FROM chunks WHERE file_path = ?').get('test.md');
  assert(row.content_updated_at != null, `content_updated_at should be set, got ${row.content_updated_at}`);
  const expectedDate = new Date(mtimeMs).toISOString();
  assert(row.content_updated_at === expectedDate, `content_updated_at should match mtime ISO, got ${row.content_updated_at}`);
  db.close();
}

// ─── Test 2: Recency uses max(created, updated, accessed) ───
console.log('Test 2: Recency uses max(created, updated, accessed)');
{
  // Chunk created 60 days ago but file updated 2 days ago should score higher
  const oldCreated = {
    confidence: 1.0, created_at: daysAgo(60), chunk_type: 'fact',
    file_weight: 1.0, _normalizedFts: 0.5, content_updated_at: daysAgo(2),
  };
  const justOld = {
    confidence: 1.0, created_at: daysAgo(60), chunk_type: 'fact',
    file_weight: 1.0, _normalizedFts: 0.5, content_updated_at: null,
  };

  const scoreFresh = score(oldCreated, nowMs, RECALL_PROFILE);
  const scoreStale = score(justOld, nowMs, RECALL_PROFILE);
  assert(scoreFresh > scoreStale, `Updated chunk (${scoreFresh.toFixed(3)}) should beat stale (${scoreStale.toFixed(3)})`);
}

// ─── Test 3: last_accessed trumps content_updated_at when newer ───
console.log('Test 3: last_accessed trumps content_updated_at when newer');
{
  const accessed = {
    confidence: 1.0, created_at: daysAgo(60), chunk_type: 'fact',
    file_weight: 1.0, _normalizedFts: 0.5,
    content_updated_at: daysAgo(30), last_accessed: daysAgo(1),
  };
  const notAccessed = {
    confidence: 1.0, created_at: daysAgo(60), chunk_type: 'fact',
    file_weight: 1.0, _normalizedFts: 0.5,
    content_updated_at: daysAgo(30), last_accessed: null,
  };

  const scoreAccessed = score(accessed, nowMs, RECALL_PROFILE);
  const scoreNot = score(notAccessed, nowMs, RECALL_PROFILE);
  assert(scoreAccessed > scoreNot, `Recently accessed (${scoreAccessed.toFixed(3)}) should beat not accessed (${scoreNot.toFixed(3)})`);
}

// ─── Test 4: Decay skips chunks updated within 14 days ───
console.log('Test 4: Decay skips chunks updated within 14 days');
{
  const db = createDb();
  // Insert a chunk created 90 days ago but updated 5 days ago
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, stale, content_updated_at)
    VALUES (?, ?, ?, 1, 5, '[]', 'fact', 0.8, ?, ?, 1.0, 0, 0, ?)`).run(
    'test.md', 'Fresh', 'Recently updated content', daysAgo(90), new Date().toISOString(), daysAgo(5)
  );
  // Insert a chunk created 90 days ago, NOT updated recently
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, stale, content_updated_at)
    VALUES (?, ?, ?, 1, 5, '[]', 'fact', 0.8, ?, ?, 1.0, 0, 0, ?)`).run(
    'old.md', 'Stale', 'Old content never updated', daysAgo(90), new Date().toISOString(), daysAgo(30)
  );

  const result = decayConfidence(db, { dryRun: true });
  const freshDecayed = result.details.find(d => d.heading === 'Fresh');
  const staleDecayed = result.details.find(d => d.heading === 'Stale');
  assert(!freshDecayed, 'Chunk updated 5 days ago should NOT be decayed (freshness immunity)');
  assert(!!staleDecayed, 'Chunk updated 30 days ago SHOULD be decayed');
  db.close();
}

// ─── Test 5: Null content_updated_at falls back to created_at ───
console.log('Test 5: Null content_updated_at falls back to created_at');
{
  const noUpdate = {
    confidence: 1.0, created_at: daysAgo(10), chunk_type: 'fact',
    file_weight: 1.0, _normalizedFts: 0.5, content_updated_at: null,
  };
  const withUpdate = {
    confidence: 1.0, created_at: daysAgo(10), chunk_type: 'fact',
    file_weight: 1.0, _normalizedFts: 0.5, content_updated_at: daysAgo(10),
  };

  const scoreNo = score(noUpdate, nowMs, RECALL_PROFILE);
  const scoreWith = score(withUpdate, nowMs, RECALL_PROFILE);
  // Should be approximately equal — both effectively 10 days old
  const ratio = scoreNo / scoreWith;
  assert(ratio > 0.95 && ratio < 1.05, `Null fallback should give same score, ratio: ${ratio.toFixed(3)}`);
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
