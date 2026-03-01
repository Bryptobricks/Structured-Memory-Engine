#!/usr/bin/env node
/**
 * Tests for remember module — write-path for daily memory files.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { remember, VALID_TAGS, _resetDedupCache } = require('../lib/remember');
const { SCHEMA } = require('../lib/store');
const { indexWorkspace } = require('../lib/indexer');
const { recall } = require('../lib/recall');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sme-test-'));
}

function createDb(workspace) {
  const dir = path.join(workspace, '.memory');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'index.sqlite'));
  db.pragma('journal_mode = WAL');
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

// ─── Test 1: Creates new file with header (atomic) ───
console.log('Test 1: Creates new file with header');
{
  const ws = tmpWorkspace();
  const result = remember(ws, 'Alex prefers dark mode', { date: '2026-02-20' });

  assert(result.created === true, `Expected created=true, got ${result.created}`);
  assert(result.filePath.endsWith('2026-02-20.md'), `Expected file ending 2026-02-20.md, got ${result.filePath}`);
  assert(result.line === '- [fact] Alex prefers dark mode', `Expected tagged line, got ${result.line}`);

  const content = fs.readFileSync(result.filePath, 'utf-8');
  assert(content.startsWith('# Session Log — 2026-02-20'), `Expected header, got: ${content.slice(0, 40)}`);
  assert(content.includes('- [fact] Alex prefers dark mode'), 'Expected content in file');
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 2: Appends to existing file ───
console.log('Test 2: Appends to existing file');
{
  const ws = tmpWorkspace();
  const r1 = remember(ws, 'First fact', { date: '2026-02-20' });
  const r2 = remember(ws, 'Second fact', { date: '2026-02-20' });

  assert(r1.created === true, 'First call should create');
  assert(r2.created === false, 'Second call should append');

  const content = fs.readFileSync(r2.filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.startsWith('- ['));
  assert(lines.length === 2, `Expected 2 tagged lines, got ${lines.length}`);
  assert(lines[0].includes('First fact'), 'First line should be first fact');
  assert(lines[1].includes('Second fact'), 'Second line should be second fact');
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 3: Default tag is 'fact' ───
console.log('Test 3: Default tag is fact');
{
  const ws = tmpWorkspace();
  const result = remember(ws, 'Something important', { date: '2026-02-20' });
  assert(result.line === '- [fact] Something important', `Expected [fact] tag, got ${result.line}`);
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 4: Custom tags ───
console.log('Test 4: Custom tags');
{
  const ws = tmpWorkspace();
  const tags = ['decision', 'pref', 'confirmed', 'inferred', 'opinion'];
  for (const tag of tags) {
    const result = remember(ws, `Tagged as ${tag}`, { tag, date: '2026-02-20' });
    assert(result.line === `- [${tag}] Tagged as ${tag}`, `Expected [${tag}] in line, got ${result.line}`);
  }
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 5: Creates memory directory if missing ───
console.log('Test 5: Creates memory directory if missing');
{
  const ws = tmpWorkspace();
  const memDir = path.join(ws, 'memory');
  assert(!fs.existsSync(memDir), 'memory/ should not exist yet');

  remember(ws, 'Test fact', { date: '2026-02-20' });
  assert(fs.existsSync(memDir), 'memory/ should have been created');
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 6: Roundtrip — remember → index → recall ───
console.log('Test 6: Roundtrip — remember → index → recall');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  remember(ws, 'Creatine 5g daily morning protocol', { tag: 'confirmed', date: '2026-02-20' });
  remember(ws, 'Switched to PostgreSQL from MySQL for the main database', { tag: 'decision', date: '2026-02-20' });

  indexWorkspace(db, ws, { force: true });
  const stats = db.prepare('SELECT COUNT(*) as n FROM chunks').get();
  assert(stats.n > 0, `Expected chunks after index, got ${stats.n}`);

  const results = recall(db, 'creatine', { workspace: ws });
  assert(results.length > 0, `Expected recall results for creatine, got ${results.length}`);
  assert(results.some(r => r.content.includes('Creatine 5g')), 'Expected to find creatine fact');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 7: Newline sanitization ───
console.log('Test 7: Newline sanitization');
{
  const ws = tmpWorkspace();
  const result = remember(ws, 'Line one\nLine two\r\nLine three', { date: '2026-02-20' });
  assert(result.line === '- [fact] Line one Line two Line three', `Expected collapsed newlines, got ${result.line}`);

  const content = fs.readFileSync(result.filePath, 'utf-8');
  const taggedLines = content.split('\n').filter(l => l.startsWith('- ['));
  assert(taggedLines.length === 1, `Expected 1 tagged line (no splits), got ${taggedLines.length}`);
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 8: Invalid tag rejection ───
console.log('Test 8: Invalid tag rejection');
{
  const ws = tmpWorkspace();
  let threw = false;
  try {
    remember(ws, 'Bad tag test', { tag: 'invalid_tag', date: '2026-02-20' });
  } catch (err) {
    threw = true;
    assert(err.message.includes('Invalid tag'), `Expected invalid tag error, got: ${err.message}`);
  }
  assert(threw, 'Should have thrown on invalid tag');
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 9: Empty content rejection ───
console.log('Test 9: Empty content rejection');
{
  const ws = tmpWorkspace();
  let threw = false;
  try {
    remember(ws, '   \n  ', { date: '2026-02-20' });
  } catch (err) {
    threw = true;
    assert(err.message.includes('empty'), `Expected empty content error, got: ${err.message}`);
  }
  assert(threw, 'Should have thrown on whitespace-only content');
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 10: No duplicate header on rapid calls ───
console.log('Test 10: No duplicate header on rapid calls');
{
  const ws = tmpWorkspace();
  // Simulate rapid sequential calls (can't truly test concurrency in single-threaded Node,
  // but the atomic create guards against it)
  remember(ws, 'Fact A', { date: '2026-02-20' });
  remember(ws, 'Fact B', { date: '2026-02-20' });
  remember(ws, 'Fact C', { date: '2026-02-20' });

  const content = fs.readFileSync(path.join(ws, 'memory', '2026-02-20.md'), 'utf-8');
  const headers = content.split('\n').filter(l => l.startsWith('# Session Log'));
  assert(headers.length === 1, `Expected exactly 1 header, got ${headers.length}`);
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 11: Duplicate content skipped (hash dedup) ───
console.log('Test 11: Duplicate content skipped (hash dedup)');
{
  _resetDedupCache();
  const ws = tmpWorkspace();
  const r1 = remember(ws, 'Bromantane weekday-only protocol', { date: '2026-03-01' });
  assert(r1.skipped !== true, 'First call should NOT be skipped');
  assert(r1.line !== null, 'First call should have a line');

  const r2 = remember(ws, 'Bromantane weekday-only protocol', { date: '2026-03-01' });
  assert(r2.skipped === true, 'Duplicate content should be skipped');
  assert(r2.line === null, 'Skipped result should have null line');

  const content = fs.readFileSync(r1.filePath, 'utf-8');
  const tagged = content.split('\n').filter(l => l.startsWith('- ['));
  assert(tagged.length === 1, `Expected exactly 1 entry (deduped), got ${tagged.length}`);
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 12: Different content same day not skipped ───
console.log('Test 12: Different content same day not skipped');
{
  _resetDedupCache();
  const ws = tmpWorkspace();
  remember(ws, 'Started creatine protocol today', { date: '2026-03-01' });
  const r2 = remember(ws, 'Decided to switch to PostgreSQL', { date: '2026-03-01' });
  assert(r2.skipped !== true, 'Different content should NOT be skipped');

  const content = fs.readFileSync(path.join(ws, 'memory', '2026-03-01.md'), 'utf-8');
  const tagged = content.split('\n').filter(l => l.startsWith('- ['));
  assert(tagged.length === 2, `Expected 2 entries for different content, got ${tagged.length}`);
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 13: Same content different days not skipped ───
console.log('Test 13: Same content different days not skipped');
{
  _resetDedupCache();
  const ws = tmpWorkspace();
  remember(ws, 'Daily standup completed', { date: '2026-03-01' });
  const r2 = remember(ws, 'Daily standup completed', { date: '2026-03-02' });
  assert(r2.skipped !== true, 'Same content on different day should NOT be skipped');
  fs.rmSync(ws, { recursive: true });
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
