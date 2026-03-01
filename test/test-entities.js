#!/usr/bin/env node
/**
 * Tests for Entity Index (lib/entities.js)
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { buildEntityIndex, getEntity, getRelatedEntities, listEntities, expandEntitiesWithCooccurrence } = require('../lib/entities');
const { getRelevantContext } = require('../lib/context');

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
  try {
    db.exec('DROP TRIGGER IF EXISTS chunks_au');
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content, heading, entities ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading, entities) VALUES ('delete', old.id, old.content, old.heading, old.entities);
      INSERT INTO chunks_fts(rowid, content, heading, entities) VALUES (new.id, new.content, new.heading, new.entities);
    END;`);
  } catch (_) {}
  return db;
}

function insertChunk(db, { heading = null, content = 'test content', chunkType = 'raw', confidence = 1.0, createdAt = null, filePath = 'test.md', entities = '[]', fileWeight = 1.0 } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale)
    VALUES (?, ?, ?, 1, 10, ?, ?, ?, ?, ?, ?, 0, NULL, 0)`).run(
    filePath, heading, content, entities, chunkType, confidence, createdAt || now, now, fileWeight
  );
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── Test 1: Build entity index ───
console.log('Test 1: Build entity index from chunks');
{
  const db = createDb();
  insertChunk(db, { content: 'Send Tom project roadmap doc', entities: JSON.stringify(['Tom', 'Nexus']), createdAt: daysAgo(3) });
  insertChunk(db, { content: 'Tom confirmed the timeline', entities: JSON.stringify(['Tom']), createdAt: daysAgo(1) });
  insertChunk(db, { content: 'DataSync lending protocol', entities: JSON.stringify(['DataSync', 'CloudStack']), createdAt: daysAgo(2) });

  const result = buildEntityIndex(db);
  assert(result.entities >= 3, `Expected at least 3 entities, got ${result.entities}`);
  assert(result.chunks === 3, `Expected 3 chunks scanned, got ${result.chunks}`);
  db.close();
}

// ─── Test 2: Query entity ───
console.log('Test 2: Query entity returns chunk IDs and co-occurrences');
{
  const db = createDb();
  insertChunk(db, { content: 'Send Tom project roadmap doc', entities: JSON.stringify(['Tom', 'Nexus']), createdAt: daysAgo(3) });
  insertChunk(db, { content: 'Tom confirmed the timeline', entities: JSON.stringify(['Tom']), createdAt: daysAgo(1) });
  buildEntityIndex(db);

  const tom = getEntity(db, 'Tom');
  assert(tom != null, 'Expected Tom entity to exist');
  assert(tom.mentionCount === 2, `Expected 2 mentions, got ${tom.mentionCount}`);
  assert(tom.chunkIds.length === 2, `Expected 2 chunk IDs, got ${tom.chunkIds.length}`);
  assert(tom.coEntities['nexus'] === 1, `Expected Nexus co-occurrence count 1, got ${tom.coEntities['nexus']}`);
  db.close();
}

// ─── Test 3: Related entities ───
console.log('Test 3: Related entities sorted by co-occurrence count');
{
  const db = createDb();
  insertChunk(db, { content: 'Alex met Tom at TechConf', entities: JSON.stringify(['Alex', 'Tom', 'TechConf']) });
  insertChunk(db, { content: 'Alex and Tom discussed DataSync', entities: JSON.stringify(['Alex', 'Tom', 'DataSync']) });
  insertChunk(db, { content: 'Alex reviewed the portfolio', entities: JSON.stringify(['Alex']) });
  buildEntityIndex(db);

  const related = getRelatedEntities(db, 'Alex');
  assert(related.length >= 1, `Expected at least 1 related entity, got ${related.length}`);
  assert(related[0].entity === 'tom', `Expected Tom as top co-occurrence, got ${related[0].entity}`);
  assert(related[0].count === 2, `Expected co-occurrence count 2, got ${related[0].count}`);
  db.close();
}

// ─── Test 4: List entities ───
console.log('Test 4: List all entities sorted by mention count');
{
  const db = createDb();
  insertChunk(db, { content: 'A', entities: JSON.stringify(['Alex', 'Tom']) });
  insertChunk(db, { content: 'B', entities: JSON.stringify(['Alex', 'DataSync']) });
  insertChunk(db, { content: 'C', entities: JSON.stringify(['Alex']) });
  buildEntityIndex(db);

  const list = listEntities(db);
  assert(list.length >= 3, `Expected at least 3 entities, got ${list.length}`);
  assert(list[0].entity === 'alex', `Expected Alex as most mentioned, got ${list[0].entity}`);
  assert(list[0].mention_count === 3, `Expected 3 mentions for Alex, got ${list[0].mention_count}`);
  db.close();
}

// ─── Test 5: Entity expansion with co-occurrence ───
console.log('Test 5: Entity expansion adds co-occurring entities');
{
  const db = createDb();
  insertChunk(db, { content: 'A', entities: JSON.stringify(['Tom', 'Nexus']) });
  insertChunk(db, { content: 'B', entities: JSON.stringify(['Tom', 'Nexus']) });
  insertChunk(db, { content: 'C', entities: JSON.stringify(['Tom', 'Jira']) });
  buildEntityIndex(db);

  const matched = new Set(['tom']);
  const expanded = expandEntitiesWithCooccurrence(db, matched, { coThreshold: 2 });
  assert(expanded.has('tom'), 'Original entity should remain');
  assert(expanded.has('nexus'), 'Nexus should be added (co-occurrence count = 2, meets threshold)');
  assert(!expanded.has('jira'), 'Jira should NOT be added (co-occurrence count = 1, below threshold)');
  db.close();
}

// ─── Test 6: Missing entity returns null ───
console.log('Test 6: Query nonexistent entity returns null');
{
  const db = createDb();
  buildEntityIndex(db);
  const result = getEntity(db, 'nonexistent');
  assert(result === null, `Expected null, got ${JSON.stringify(result)}`);
  db.close();
}

// ─── Test 7: Entity graph enhances CIL results ───
console.log('Test 7: CIL uses entity co-occurrence to expand results');
{
  const db = createDb();
  // Tom and Nexus always co-occur
  insertChunk(db, { content: 'Send Tom project roadmap with API health plan for Nexus rate limits.', heading: 'Action Items', entities: JSON.stringify(['Tom', 'Nexus']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(3), filePath: 'memory/2026-02-24.md' });
  insertChunk(db, { content: 'Tom confirmed Nexus deployment timeline and scaling plan.', heading: 'Meetings', entities: JSON.stringify(['Tom', 'Nexus']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(1), filePath: 'memory/2026-02-26.md' });
  // Nexus-only chunk (no Tom mention in text, but entity tag)
  insertChunk(db, { content: 'Nexus API health monitoring dashboard needs real-time alerts for latency spikes.', heading: 'Backend Ops', entities: JSON.stringify(['Nexus']), chunkType: 'decision', confidence: 0.95, createdAt: daysAgo(2), filePath: 'memory/2026-02-25.md' });

  // Build entity index first
  buildEntityIndex(db);

  // Query about Tom — should pull in Nexus chunks via co-occurrence
  const result = getRelevantContext(db, 'What does Tom need from us?');
  assert(result.chunks.length >= 2, `Expected at least 2 chunks, got ${result.chunks.length}`);
  const hasNexus = result.chunks.some(c => c.content.includes('Nexus'));
  assert(hasNexus, 'Expected Nexus-related chunk via Tom co-occurrence');
  db.close();
}

// ─── Test 8: Dry run doesn't write ───
console.log('Test 8: Dry run reports counts without writing');
{
  const db = createDb();
  insertChunk(db, { content: 'A', entities: JSON.stringify(['Alex']) });
  insertChunk(db, { content: 'B', entities: JSON.stringify(['Tom']) });

  const result = buildEntityIndex(db, { dryRun: true });
  assert(result.entities === 2, `Expected 2 entities, got ${result.entities}`);

  // Should not have written to DB
  const query = getEntity(db, 'Alex');
  assert(query === null, 'Dry run should not write to entity_index');
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
