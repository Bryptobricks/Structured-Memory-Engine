#!/usr/bin/env node
/**
 * Tests for lib/memory-actions.js — update/replace/forget/protect.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { openDb, insertChunks } = require('../lib/store');
const {
  executeAction, resolveTarget,
  AmbiguousTargetError, TargetNotFoundError,
} = require('../lib/memory-actions');
const { runReflectCycle } = require('../lib/reflect');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-actions-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  return ws;
}

console.log('Test 1: update — preserves id and created_at');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'The redis cache TTL is 120 seconds', heading: 'Cache', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], '2026-01-01T00:00:00.000Z');

  const before = db.prepare('SELECT * FROM chunks LIMIT 1').get();
  const result = executeAction(db, { action: 'update', target: before.id, content: 'The redis cache TTL is now 300 seconds' });
  const after = db.prepare('SELECT * FROM chunks WHERE id = ?').get(before.id);

  assert(result.action === 'update', 'result.action=update');
  assert(after.id === before.id, `id preserved: ${after.id} === ${before.id}`);
  assert(after.created_at === before.created_at, 'created_at preserved');
  assert(after.content === 'The redis cache TTL is now 300 seconds', `content updated, got "${after.content}"`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 2: replace — archives old, creates new with superseded_by');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Gateway runs on port 3000', heading: 'Gateway', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], '2026-01-01T00:00:00.000Z');

  const before = db.prepare('SELECT * FROM chunks LIMIT 1').get();
  const result = executeAction(db, { action: 'replace', target: before.id, content: 'Gateway runs on port 8080' });

  const oldChunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(before.id);
  const newChunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(result.newId);

  assert(oldChunk.confidence === 0, `old chunk confidence zeroed: ${oldChunk.confidence}`);
  assert(oldChunk.superseded_by === result.newId, `superseded_by set: ${oldChunk.superseded_by} === ${result.newId}`);
  assert(oldChunk.archived_at != null, 'old chunk has archived_at');
  assert(newChunk != null, 'new chunk exists');
  assert(newChunk.content === 'Gateway runs on port 8080', 'new chunk has new content');
  assert(newChunk.file_path === before.file_path, 'new chunk preserves file_path');
  assert(newChunk.id !== before.id, 'new id is different');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 3: forget — soft-delete via confidence + archived_at');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Old fact that should be forgotten', heading: 'Old', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], '2026-01-01T00:00:00.000Z');

  const before = db.prepare('SELECT * FROM chunks LIMIT 1').get();
  executeAction(db, { action: 'forget', target: before.id });
  const after = db.prepare('SELECT * FROM chunks WHERE id = ?').get(before.id);

  assert(after.confidence === 0, `confidence zeroed: ${after.confidence}`);
  assert(after.archived_at != null, 'archived_at set');
  assert(after.content === before.content, 'content preserved (soft delete)');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 4: protect — sets protected flag, survives reflect decay');
{
  const ws = tmpWs();
  const db = openDb(ws);
  // Insert an old chunk that would normally decay
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Protected fact about the project', heading: 'Facts', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact', confidence: 0.5 },
  ], '2024-01-01T00:00:00.000Z');

  // Backdate the chunk so decay math has something to bite
  db.prepare("UPDATE chunks SET created_at = ?, last_accessed = ? WHERE id = 1")
    .run('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  // Start it at confidence that would otherwise decay below zero
  db.prepare('UPDATE chunks SET confidence = 0.5 WHERE id = 1').run();

  executeAction(db, { action: 'protect', target: 1 });
  const protectedChunk = db.prepare('SELECT * FROM chunks WHERE id = 1').get();
  assert(protectedChunk.protected === 1, `protected=1, got ${protectedChunk.protected}`);

  // Run reflect decay — protected chunk should NOT lose confidence
  runReflectCycle(db, { dryRun: false });
  const afterReflect = db.prepare('SELECT confidence, stale FROM chunks WHERE id = 1').get();
  assert(afterReflect.confidence === 0.5, `protected chunk confidence unchanged, got ${afterReflect.confidence}`);
  assert(afterReflect.stale === 0, `protected chunk not marked stale, got ${afterReflect.stale}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 5: resolveTarget — numeric id');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'chunk A', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
    { content: 'chunk B', heading: null, lineStart: 2, lineEnd: 2, entities: [], chunkType: 'raw' },
  ], null);

  const row = resolveTarget(db, 1, { workspace: ws });
  assert(row.id === 1, `resolved id=1, got ${row.id}`);
  assert(row.content === 'chunk A', 'resolved correct content');

  // String numeric also works
  const row2 = resolveTarget(db, '2', { workspace: ws });
  assert(row2.id === 2, 'string numeric resolves');

  // Missing id throws
  let threw = false;
  try { resolveTarget(db, 99999, { workspace: ws }); }
  catch (e) { threw = e instanceof TargetNotFoundError; }
  assert(threw, 'missing id throws TargetNotFoundError');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 6: resolveTarget — query-based with clear winner');
{
  const ws = tmpWs();
  const db = openDb(ws);
  // One chunk strongly matching "redis ttl", another unrelated
  insertChunks(db, 'memory/redis.md', Date.now(), [
    { content: 'redis cache ttl is 300 seconds for session cookies in production', heading: 'Redis', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);
  insertChunks(db, 'memory/other.md', Date.now(), [
    { content: 'completely unrelated thing about something else entirely', heading: 'Other', lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  const row = resolveTarget(db, 'redis cache ttl seconds', { workspace: ws });
  assert(row.content.includes('redis cache ttl'), `resolved to redis chunk, got "${row.content.slice(0, 50)}..."`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 7: resolveTarget — ambiguous query raises AmbiguousTargetError');
{
  const ws = tmpWs();
  const db = openDb(ws);
  // Two identical chunks in different files — unambiguously ambiguous
  insertChunks(db, 'memory/v1.md', Date.now(), [
    { content: 'gateway listens on port 3000 in development', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);
  insertChunks(db, 'memory/v2.md', Date.now(), [
    { content: 'gateway listens on port 3000 in development', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);

  let err = null;
  try { resolveTarget(db, 'gateway port 3000', { workspace: ws }); }
  catch (e) { err = e; }
  // This is the whole point of the ambiguity check — if it passes "maybe it's
  // TargetNotFound that's fine", the actual ambiguity code path is untested.
  assert(err instanceof AmbiguousTargetError,
    `expected AmbiguousTargetError for identical-content collision, got ${err && err.name}: ${err && err.message}`);
  if (err instanceof AmbiguousTargetError) {
    assert(err.candidates.length >= 2, `candidates surfaced: ${err.candidates.length}`);
    assert(err.candidates[0].content.includes('gateway'), 'candidate content preserved');
    assert(err.candidates[0].score > 0, 'candidate has a score');
    assert(err.candidates[0].id != null, 'candidate has an id');
  }
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 7b: resolveTarget — weak match returns TargetNotFoundError');
{
  const ws = tmpWs();
  const db = openDb(ws);
  // Corpus has nothing remotely matching the target query
  insertChunks(db, 'memory/x.md', Date.now(), [
    { content: 'completely unrelated fact about databases', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], null);

  let err = null;
  try { resolveTarget(db, 'quantum mechanics wavefunction collapse', { workspace: ws }); }
  catch (e) { err = e; }
  assert(err instanceof TargetNotFoundError,
    `expected TargetNotFoundError for off-topic query, got ${err && err.name}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 7c: update/replace re-extract entities from new content');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'Notes about the auth module mentioning @oldapp', heading: null, lineStart: 1, lineEnd: 1, entities: ['@oldapp'], chunkType: 'raw' },
  ], null);
  const before = db.prepare('SELECT * FROM chunks LIMIT 1').get();

  // Update to content with new @mention — extractEntities picks up @mentions, **bold**, acronyms
  executeAction(db, { action: 'update', target: before.id, content: '@Nexus is now the new auth provider replacing @oldapp' });
  const afterUpdate = db.prepare('SELECT entities FROM chunks WHERE id = ?').get(before.id);
  const updatedEntities = JSON.parse(afterUpdate.entities);
  assert(updatedEntities.includes('@Nexus'),
    `update should re-extract @Nexus; got ${JSON.stringify(updatedEntities)}`);

  // Replace: new chunk should have new-content entities, not old chunk's entities
  const replaceRes = executeAction(db, { action: 'replace', target: before.id, content: 'Content mentions @Echelon and **ProjectX**' });
  const newRow = db.prepare('SELECT entities FROM chunks WHERE id = ?').get(replaceRes.newId);
  const newEntities = JSON.parse(newRow.entities);
  assert(newEntities.includes('@Echelon'), `replace should extract @Echelon; got ${JSON.stringify(newEntities)}`);
  assert(newEntities.includes('ProjectX'), `replace should extract **ProjectX**; got ${JSON.stringify(newEntities)}`);
  assert(!newEntities.includes('@oldapp'), `replace should NOT carry forward old entities; got ${JSON.stringify(newEntities)}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 8: protect prevents pruning');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'important long-term fact', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'fact' },
  ], '2024-01-01T00:00:00.000Z');

  // Mark stale and force ultra-low confidence so pruneStale would otherwise archive it
  db.prepare('UPDATE chunks SET stale = 1, confidence = 0.01, created_at = ? WHERE id = 1')
    .run('2024-01-01T00:00:00.000Z');

  executeAction(db, { action: 'protect', target: 1 });

  const { pruneStale } = require('../lib/reflect');
  const result = pruneStale(db);
  assert(result.archived === 0, `protected chunk not archived, got ${result.archived}`);
  const stillExists = db.prepare('SELECT id FROM chunks WHERE id = 1').get();
  assert(stillExists != null, 'protected chunk still in chunks table');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 9: action errors — missing content on update');
{
  const ws = tmpWs();
  const db = openDb(ws);
  insertChunks(db, 'memory/test.md', Date.now(), [
    { content: 'chunk', heading: null, lineStart: 1, lineEnd: 1, entities: [], chunkType: 'raw' },
  ], null);

  let threw = false;
  try { executeAction(db, { action: 'update', target: 1 }); }
  catch (_) { threw = true; }
  assert(threw, 'update without content throws');

  let threw2 = false;
  try { executeAction(db, { action: 'replace', target: 1 }); }
  catch (_) { threw2 = true; }
  assert(threw2, 'replace without content throws');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
