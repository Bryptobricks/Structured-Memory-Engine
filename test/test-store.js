#!/usr/bin/env node
/**
 * Tests for store.js — direct unit tests for every exported function.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SCHEMA, openDb, getFileMeta, deleteFileChunks, insertChunks, search, getAdjacentChunks, getStats, getAllFilePaths } = require('../lib/store');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sme-store-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createInMemoryDb() {
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

// ─── Test 1: openDb — schema creation, migrations, WAL mode, idempotency ───
console.log('Test 1: openDb');
{
  const dir = makeTempDir();
  try {
    const db1 = openDb(dir);

    // WAL mode
    const journal = db1.pragma('journal_mode', { simple: true });
    assert(journal === 'wal', `Expected WAL mode, got ${journal}`);

    // Tables exist
    const tables = db1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert(tables.includes('chunks'), 'chunks table exists');
    assert(tables.includes('files'), 'files table exists');
    assert(tables.includes('contradictions'), 'contradictions table exists');
    assert(tables.includes('archived_chunks'), 'archived_chunks table exists');

    // Migrations ran — file_weight column exists
    const cols = db1.prepare("PRAGMA table_info(chunks)").all().map(r => r.name);
    assert(cols.includes('file_weight'), 'file_weight column exists after migration');
    assert(cols.includes('access_count'), 'access_count column exists after migration');
    assert(cols.includes('last_accessed'), 'last_accessed column exists after migration');
    assert(cols.includes('stale'), 'stale column exists after migration');

    db1.close();

    // Idempotency — opening again should not throw
    const db2 = openDb(dir);
    const tables2 = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert(tables2.includes('chunks'), 'Idempotent: chunks table still exists');
    db2.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 2: getFileMeta — returns metadata or undefined ───
console.log('Test 2: getFileMeta');
{
  const db = createInMemoryDb();

  // No file yet — undefined
  const missing = getFileMeta(db, 'nonexistent.md');
  assert(missing === undefined, `Expected undefined for missing file, got ${missing}`);

  // Insert a file entry
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, ?, ?)').run('test.md', 12345, 3, now);

  const meta = getFileMeta(db, 'test.md');
  assert(meta !== undefined, 'Expected metadata for test.md');
  assert(meta.file_path === 'test.md', `Expected file_path test.md, got ${meta.file_path}`);
  assert(meta.mtime_ms === 12345, `Expected mtime_ms 12345, got ${meta.mtime_ms}`);
  assert(meta.chunk_count === 3, `Expected chunk_count 3, got ${meta.chunk_count}`);

  db.close();
}

// ─── Test 3: deleteFileChunks — removes chunks + file entry, FTS trigger fires ───
console.log('Test 3: deleteFileChunks');
{
  const db = createInMemoryDb();
  const now = new Date().toISOString();

  // Insert chunks and file entry
  db.prepare('INSERT INTO chunks (file_path, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight) VALUES (?, ?, 1, 5, ?, ?, ?, ?, ?, ?)').run('del.md', 'deletable content alpha', '[]', 'raw', 1.0, now, now, 1.0);
  db.prepare('INSERT INTO chunks (file_path, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight) VALUES (?, ?, 6, 10, ?, ?, ?, ?, ?, ?)').run('del.md', 'deletable content bravo', '[]', 'raw', 1.0, now, now, 1.0);
  db.prepare('INSERT INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, ?, ?)').run('del.md', 99999, 2, now);

  // Also insert a chunk for another file (should not be affected)
  db.prepare('INSERT INTO chunks (file_path, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight) VALUES (?, ?, 1, 5, ?, ?, ?, ?, ?, ?)').run('keep.md', 'keep this content', '[]', 'raw', 1.0, now, now, 1.0);
  db.prepare('INSERT INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, ?, ?)').run('keep.md', 88888, 1, now);

  // Verify FTS has the content before delete
  const ftsBefore = db.prepare("SELECT COUNT(*) as n FROM chunks_fts WHERE chunks_fts MATCH 'deletable'").get().n;
  assert(ftsBefore === 2, `Expected 2 FTS matches before delete, got ${ftsBefore}`);

  deleteFileChunks(db, 'del.md');

  // Chunks gone
  const chunksAfter = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'del.md'").get().n;
  assert(chunksAfter === 0, `Expected 0 chunks after delete, got ${chunksAfter}`);

  // File entry gone
  const fileAfter = getFileMeta(db, 'del.md');
  assert(fileAfter === undefined, 'Expected no file entry after delete');

  // FTS trigger fired — content no longer searchable
  const ftsAfter = db.prepare("SELECT COUNT(*) as n FROM chunks_fts WHERE chunks_fts MATCH 'deletable'").get().n;
  assert(ftsAfter === 0, `Expected 0 FTS matches after delete, got ${ftsAfter}`);

  // Other file unaffected
  const keepChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'keep.md'").get().n;
  assert(keepChunks === 1, `Expected keep.md chunks untouched, got ${keepChunks}`);

  db.close();
}

// ─── Test 4: insertChunks — batch insert, file weights, entities, chunkType/confidence, re-insert replaces ───
console.log('Test 4: insertChunks');
{
  const db = createInMemoryDb();

  const chunks = [
    { heading: 'Health', content: 'Takes magnesium daily', lineStart: 1, lineEnd: 3, entities: ['magnesium'], chunkType: 'confirmed', confidence: 1.0 },
    { heading: 'Stack', content: 'Uses React 19 and Zustand', lineStart: 4, lineEnd: 6, entities: ['React', 'Zustand'], chunkType: 'fact', confidence: 0.9 },
  ];

  insertChunks(db, 'MEMORY.md', 12345, chunks, '2026-02-20T00:00:00.000Z');

  // Chunks inserted
  const rows = db.prepare("SELECT * FROM chunks WHERE file_path = 'MEMORY.md' ORDER BY line_start").all();
  assert(rows.length === 2, `Expected 2 chunks, got ${rows.length}`);
  assert(rows[0].heading === 'Health', `Expected heading Health, got ${rows[0].heading}`);
  assert(rows[0].chunk_type === 'confirmed', `Expected confirmed, got ${rows[0].chunk_type}`);
  assert(rows[1].confidence === 0.9, `Expected confidence 0.9, got ${rows[1].confidence}`);

  // File weight for MEMORY.md should be 1.5
  assert(rows[0].file_weight === 1.5, `Expected MEMORY.md weight 1.5, got ${rows[0].file_weight}`);

  // Entities serialized as JSON
  const entities = JSON.parse(rows[0].entities);
  assert(entities.includes('magnesium'), `Expected magnesium in entities, got ${entities}`);

  // File entry created
  const meta = getFileMeta(db, 'MEMORY.md');
  assert(meta !== undefined, 'Expected file entry');
  assert(meta.chunk_count === 2, `Expected chunk_count 2, got ${meta.chunk_count}`);
  assert(meta.mtime_ms === 12345, `Expected mtime_ms 12345, got ${meta.mtime_ms}`);

  // Re-insert replaces (no duplicates)
  const newChunks = [
    { heading: 'Health', content: 'Updated health info', lineStart: 1, lineEnd: 5, entities: [], chunkType: 'raw', confidence: 1.0 },
  ];
  insertChunks(db, 'MEMORY.md', 99999, newChunks, null);

  const afterReplace = db.prepare("SELECT * FROM chunks WHERE file_path = 'MEMORY.md'").all();
  assert(afterReplace.length === 1, `Expected 1 chunk after re-insert, got ${afterReplace.length}`);
  assert(afterReplace[0].content === 'Updated health info', 'Content should be replaced');

  db.close();
}

// ─── Test 5: search — FTS5, stale exclusion, type filter, confidence filter, sinceDate, access tracking, limit ───
console.log('Test 5: search');
{
  const db = createInMemoryDb();
  const now = new Date().toISOString();
  const oldDate = '2025-01-01T00:00:00.000Z';

  // Insert test chunks via raw SQL for precise control
  const insert = db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 0, NULL, ?)`);
  insert.run('a.md', 'H1', 'creatine sublingual dosing protocol', 1, 5, '[]', 'confirmed', 1.0, now, now, 0);
  insert.run('b.md', 'H2', 'magnesium glycinate before bed', 1, 5, '[]', 'fact', 0.8, now, now, 0);
  insert.run('c.md', 'H3', 'stale creatine reference from old data', 1, 5, '[]', 'outdated', 0.3, oldDate, now, 1);
  insert.run('d.md', 'H4', 'old magnesium note from 2025', 1, 5, '[]', 'inferred', 0.7, oldDate, now, 0);
  db.prepare('INSERT INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, 1, ?)').run('a.md', 1, now);
  db.prepare('INSERT INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, 1, ?)').run('b.md', 1, now);
  db.prepare('INSERT INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, 1, ?)').run('c.md', 1, now);
  db.prepare('INSERT INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, 1, ?)').run('d.md', 1, now);

  // Basic search
  const basic = search(db, 'creatine');
  assert(basic.length === 1, `Basic search: expected 1 (stale excluded), got ${basic.length}`);
  assert(basic[0].file_path === 'a.md', 'Should find non-stale creatine');

  // includeStale
  const withStale = search(db, 'creatine', { includeStale: true });
  assert(withStale.length === 2, `With stale: expected 2, got ${withStale.length}`);

  // Type filter
  const facts = search(db, 'magnesium', { chunkType: 'fact' });
  assert(facts.length === 1, `Type filter: expected 1 fact, got ${facts.length}`);

  // Confidence filter
  const highConf = search(db, 'magnesium', { minConfidence: 0.75 });
  assert(highConf.length === 1, `Confidence filter >= 0.75: expected 1, got ${highConf.length}`);
  assert(highConf[0].file_path === 'b.md', 'Should find b.md (0.8 confidence)');

  // sinceDate filter
  const recent = search(db, 'magnesium', { sinceDate: '2026-01-01T00:00:00.000Z' });
  assert(recent.length === 1, `sinceDate filter: expected 1, got ${recent.length}`);

  // Access tracking (a.md matched by both basic and withStale searches above)
  const tracked = db.prepare("SELECT access_count FROM chunks WHERE file_path = 'a.md'").get();
  assert(tracked.access_count === 2, `Expected access_count 2 after two matching searches, got ${tracked.access_count}`);

  // Limit
  const limited = search(db, 'magnesium', { limit: 1, includeStale: true });
  assert(limited.length === 1, `Limit 1: expected 1, got ${limited.length}`);

  // skipTracking — search still returns results but does not increment access_count
  const beforeSkip = db.prepare("SELECT access_count FROM chunks WHERE file_path = 'a.md'").get();
  const skipResult = search(db, 'creatine', { skipTracking: true });
  assert(skipResult.length === 1, `skipTracking: expected 1 result, got ${skipResult.length}`);
  const afterSkip = db.prepare("SELECT access_count FROM chunks WHERE file_path = 'a.md'").get();
  assert(afterSkip.access_count === beforeSkip.access_count, `skipTracking: access_count should not change, was ${beforeSkip.access_count}, now ${afterSkip.access_count}`);

  db.close();
}

// ─── Test 6: getAdjacentChunks — context window ───
console.log('Test 6: getAdjacentChunks');
{
  const db = createInMemoryDb();
  const now = new Date().toISOString();

  // Insert 5 sequential chunks in same file
  const insert = db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, '[]', 'raw', 1.0, ?, ?, 1.0)`);
  insert.run('multi.md', 'A', 'chunk alpha', 1, 10, now, now);
  insert.run('multi.md', 'B', 'chunk bravo', 11, 20, now, now);
  insert.run('multi.md', 'C', 'chunk charlie', 21, 30, now, now);
  insert.run('multi.md', 'D', 'chunk delta', 31, 40, now, now);
  insert.run('multi.md', 'E', 'chunk echo', 41, 50, now, now);

  // Middle chunk (C), n=1
  const middle = getAdjacentChunks(db, 'multi.md', 21, 30, 1);
  assert(middle.length === 2, `Middle n=1: expected 2 adjacent, got ${middle.length}`);
  assert(middle[0].content === 'chunk bravo', `Before should be bravo, got ${middle[0].content}`);
  assert(middle[1].content === 'chunk delta', `After should be delta, got ${middle[1].content}`);

  // First chunk (A), n=1 — nothing before
  const first = getAdjacentChunks(db, 'multi.md', 1, 10, 1);
  assert(first.length === 1, `First n=1: expected 1, got ${first.length}`);
  assert(first[0].content === 'chunk bravo', 'Only after chunk B');

  // Last chunk (E), n=1 — nothing after
  const last = getAdjacentChunks(db, 'multi.md', 41, 50, 1);
  assert(last.length === 1, `Last n=1: expected 1, got ${last.length}`);
  assert(last[0].content === 'chunk delta', 'Only before chunk D');

  // n=2 from middle
  const wider = getAdjacentChunks(db, 'multi.md', 21, 30, 2);
  assert(wider.length === 4, `Middle n=2: expected 4, got ${wider.length}`);

  // Missing chunk — no match
  const missing = getAdjacentChunks(db, 'multi.md', 99, 100, 1);
  assert(missing.length === 0, `Missing chunk: expected 0, got ${missing.length}`);

  // Wrong file
  const wrongFile = getAdjacentChunks(db, 'nonexistent.md', 21, 30, 1);
  assert(wrongFile.length === 0, `Wrong file: expected 0, got ${wrongFile.length}`);

  db.close();
}

// ─── Test 7: getStats — empty DB, populated DB, file entries ───
console.log('Test 7: getStats');
{
  const db = createInMemoryDb();

  // Empty DB
  const empty = getStats(db);
  assert(empty.fileCount === 0, `Empty DB: expected 0 files, got ${empty.fileCount}`);
  assert(empty.chunkCount === 0, `Empty DB: expected 0 chunks, got ${empty.chunkCount}`);
  assert(empty.files.length === 0, `Empty DB: expected empty files list, got ${empty.files.length}`);

  // Populated DB
  const chunks = [
    { heading: 'A', content: 'content alpha', lineStart: 1, lineEnd: 5, entities: [] },
    { heading: 'B', content: 'content bravo', lineStart: 6, lineEnd: 10, entities: [] },
  ];
  insertChunks(db, 'test.md', 12345, chunks, null);
  insertChunks(db, 'other.md', 67890, [{ heading: 'C', content: 'content charlie', lineStart: 1, lineEnd: 5, entities: [] }], null);

  const populated = getStats(db);
  assert(populated.fileCount === 2, `Populated: expected 2 files, got ${populated.fileCount}`);
  assert(populated.chunkCount === 3, `Populated: expected 3 chunks, got ${populated.chunkCount}`);
  assert(populated.files.length === 2, `Populated: expected 2 file entries, got ${populated.files.length}`);

  // File entries have expected shape
  const testFile = populated.files.find(f => f.file_path === 'test.md');
  assert(testFile !== undefined, 'Expected test.md in file list');
  assert(testFile.chunk_count === 2, `Expected chunk_count 2 for test.md, got ${testFile.chunk_count}`);

  db.close();
}

// ─── Test 8: getAllFilePaths — empty DB, populated DB ───
console.log('Test 8: getAllFilePaths');
{
  const db = createInMemoryDb();

  // Empty DB
  const emptyPaths = getAllFilePaths(db);
  assert(emptyPaths.length === 0, `Empty DB: expected 0 paths, got ${emptyPaths.length}`);

  // Populated DB
  insertChunks(db, 'alpha.md', 111, [{ heading: 'A', content: 'alpha', lineStart: 1, lineEnd: 1, entities: [] }], null);
  insertChunks(db, 'bravo.md', 222, [{ heading: 'B', content: 'bravo', lineStart: 1, lineEnd: 1, entities: [] }], null);
  insertChunks(db, 'charlie.md', 333, [{ heading: 'C', content: 'charlie', lineStart: 1, lineEnd: 1, entities: [] }], null);

  const paths = getAllFilePaths(db);
  assert(paths.length === 3, `Populated: expected 3 paths, got ${paths.length}`);
  assert(paths.includes('alpha.md'), 'Should include alpha.md');
  assert(paths.includes('bravo.md'), 'Should include bravo.md');
  assert(paths.includes('charlie.md'), 'Should include charlie.md');

  // After deleting one
  deleteFileChunks(db, 'bravo.md');
  const afterDelete = getAllFilePaths(db);
  assert(afterDelete.length === 2, `After delete: expected 2 paths, got ${afterDelete.length}`);
  assert(!afterDelete.includes('bravo.md'), 'Should not include deleted bravo.md');

  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
