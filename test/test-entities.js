#!/usr/bin/env node
/**
 * Tests for Entity Index (lib/entities.js)
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { buildEntityIndex, getEntity, getRelatedEntities, listEntities, expandEntitiesWithCooccurrence, generateEntityPage, generateEntityPages } = require('../lib/entities');
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
  try { db.exec('ALTER TABLE chunks ADD COLUMN content_updated_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN source_type TEXT DEFAULT \'indexed\''); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN domain TEXT DEFAULT \'general\''); } catch (_) {}
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

// ─── Test 9: Stop entities filtered from index ───
console.log('Test 9: Stop entities filtered from entity graph');
{
  const db = createDb();
  // "NEVER", "TODO", "TBD" should be filtered by stoplist; "Google" and "Sarah" should remain
  insertChunk(db, { content: 'NEVER do this, TODO for later, TBD on timing', entities: JSON.stringify(['NEVER', 'TODO', 'TBD', 'Google', 'Sarah']) });
  buildEntityIndex(db);

  const never = getEntity(db, 'never');
  assert(never === null, 'NEVER should be filtered by stoplist');
  const todo = getEntity(db, 'todo');
  assert(todo === null, 'TODO should be filtered by stoplist');
  const tbd = getEntity(db, 'tbd');
  assert(tbd === null, 'TBD should be filtered by stoplist');

  const google = getEntity(db, 'google');
  assert(google !== null, 'Google should NOT be filtered');
  const sarah = getEntity(db, 'sarah');
  assert(sarah !== null, 'Sarah should NOT be filtered');
  db.close();
}

// ─── Test 10: 2-char entities preserved ───
console.log('Test 10: 2-char entities like AI, ML preserved');
{
  const db = createDb();
  insertChunk(db, { content: 'AI and ML research', entities: JSON.stringify(['AI', 'ML']) });
  buildEntityIndex(db);

  const ai = getEntity(db, 'ai');
  assert(ai !== null, 'AI (2-char) should be preserved');
  const ml = getEntity(db, 'ml');
  assert(ml !== null, 'ML (2-char) should be preserved');
  db.close();
}

// ─── Test 11: Stop entities excluded from co-occurrence ───
console.log('Test 11: Stop entities excluded from co-occurrence tracking');
{
  const db = createDb();
  insertChunk(db, { content: 'Sarah fixed the status update', entities: JSON.stringify(['Sarah', 'status', 'fixed']) });
  buildEntityIndex(db);

  const sarah = getEntity(db, 'sarah');
  assert(sarah !== null, 'Sarah should exist in index');
  // "status" and "fixed" are in the stoplist — they should not appear as co-entities
  assert(!sarah.coEntities['status'], 'status should not appear as co-entity (stoplist)');
  assert(!sarah.coEntities['fixed'], 'fixed should not appear as co-entity (stoplist)');
  db.close();
}

// ─── Test 12: generateEntityPage returns markdown for known entity ───
console.log('Test 12: generateEntityPage returns markdown with sections');
{
  const db = createDb();
  insertChunk(db, { content: 'Tom reviewed the API design for Nexus', heading: 'Code Review', entities: JSON.stringify(['Tom', 'Nexus']), createdAt: daysAgo(3), filePath: 'memory/2026-03-14.md' });
  insertChunk(db, { content: 'Tom deployed the staging build', heading: 'Deploys', entities: JSON.stringify(['Tom']), createdAt: daysAgo(1), filePath: 'memory/2026-03-16.md' });
  buildEntityIndex(db);

  const page = generateEntityPage(db, 'Tom');
  assert(page !== null, 'Should return markdown for known entity');
  assert(page.startsWith('# tom'), `Should start with entity heading, got: ${page.slice(0, 20)}`);
  assert(page.includes('**Mentions:** 2'), 'Should include mention count');
  assert(page.includes('## Related Entities'), 'Should include related entities section');
  assert(page.includes('nexus'), 'Should list Nexus as related entity');
  assert(page.includes('## Memories'), 'Should include memories section');
  assert(page.includes('Tom reviewed the API design'), 'Should include chunk content');
  db.close();
}

// ─── Test 13: generateEntityPage returns null for unknown entity ───
console.log('Test 13: generateEntityPage returns null for unknown entity');
{
  const db = createDb();
  buildEntityIndex(db);
  const page = generateEntityPage(db, 'nobody');
  assert(page === null, `Expected null, got ${typeof page}`);
  db.close();
}

// ─── Test 14: generateEntityPages writes files to disk ───
console.log('Test 14: generateEntityPages writes markdown files');
{
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const db = createDb();
  insertChunk(db, { content: 'Alex leads frontend', entities: JSON.stringify(['Alex', 'React']), createdAt: daysAgo(5) });
  insertChunk(db, { content: 'Alex reviewed PR', entities: JSON.stringify(['Alex']), createdAt: daysAgo(1) });
  insertChunk(db, { content: 'Solo mention of Jira', entities: JSON.stringify(['Jira']), createdAt: daysAgo(2) });
  buildEntityIndex(db);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-entity-pages-'));
  const result = generateEntityPages(db, tmpDir, { minMentions: 2 });
  assert(result.generated === 1, `Expected 1 page (Alex has 2 mentions), got ${result.generated}`);
  assert(result.pages[0].entity === 'alex', `Expected alex, got ${result.pages[0].entity}`);

  const filePath = path.join(tmpDir, result.pages[0].file);
  assert(fs.existsSync(filePath), 'Markdown file should exist on disk');
  const content = fs.readFileSync(filePath, 'utf8');
  assert(content.includes('# alex'), 'File should contain entity heading');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
  db.close();
}

// ─── Test 15: generateEntityPages respects minMentions filter ───
console.log('Test 15: generateEntityPages skips entities below minMentions');
{
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const db = createDb();
  insertChunk(db, { content: 'A', entities: JSON.stringify(['Alpha', 'Beta']) });
  insertChunk(db, { content: 'B', entities: JSON.stringify(['Alpha', 'Beta']) });
  insertChunk(db, { content: 'C', entities: JSON.stringify(['Alpha']) });
  buildEntityIndex(db);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-entity-pages-'));
  const result = generateEntityPages(db, tmpDir, { minMentions: 3 });
  assert(result.generated === 1, `Expected 1 page (only Alpha has 3+), got ${result.generated}`);

  fs.rmSync(tmpDir, { recursive: true });
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
