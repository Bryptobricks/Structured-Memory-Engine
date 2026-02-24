#!/usr/bin/env node
/**
 * Tests for MCP handler functions — unit tests without stdio transport.
 * Handlers receive workspace as a parameter, so no module-level capture issues.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { indexWorkspace } = require('../lib/indexer');
const { handleQuery, handleRemember, handleIndex, handleReflect, handleStatus, indexSingleFile } = require('../lib/mcp-server');
const { remember } = require('../lib/remember');
const { loadConfig, resolveIncludes, DEFAULTS } = require('../lib/config');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sme-mcp-test-'));
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

function insertChunk(db, { heading = null, content = 'test content', chunkType = 'raw', confidence = 1.0, createdAt = null, filePath = 'test.md' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale)
    VALUES (?, ?, ?, 1, 10, '[]', ?, ?, ?, ?, 1.0, 0, NULL, 0)`).run(
    filePath, heading, content, chunkType, confidence, createdAt || now, now
  );
  db.prepare('INSERT OR REPLACE INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, 1, ?)').run(filePath, Date.now(), now);
}

// ─── Test 1: handleQuery formatting ───
console.log('Test 1: handleQuery formatting');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);
  insertChunk(db, { heading: 'Health', content: 'JB takes bromantane sublingual 50mg daily for focus', chunkType: 'confirmed', confidence: 1.0, filePath: 'memory/2026-02-20.md' });
  insertChunk(db, { heading: 'Stack', content: 'magnesium glycinate 400mg before bed', chunkType: 'fact', confidence: 0.9, filePath: 'MEMORY.md' });

  const result = handleQuery(db, ws, { query: 'bromantane' });
  assert(result.content.length === 1, `Expected 1 content block, got ${result.content.length}`);
  const text = result.content[0].text;
  assert(text.includes('memory/2026-02-20.md'), `Expected file path in output, got: ${text.slice(0, 100)}`);
  assert(text.includes('score:'), 'Expected score in output');
  assert(text.includes('bromantane'), 'Expected content snippet');
  assert(text.includes('result(s)'), 'Expected result count');
  assert(!result.isError, 'Should not be error');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 2: handleQuery empty results ───
console.log('Test 2: handleQuery empty results');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  const result = handleQuery(db, ws, { query: 'nonexistent_xyz_query' });
  const text = result.content[0].text;
  assert(text === 'No results found.', `Expected 'No results found.', got: ${text}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 3: handleRemember roundtrip ───
console.log('Test 3: handleRemember roundtrip');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  // Write a fact, then index, then query
  remember(ws, 'Test fact for roundtrip verification', { tag: 'confirmed', date: '2026-02-20' });
  indexWorkspace(db, ws, { force: true });

  const queryResult = handleQuery(db, ws, { query: 'roundtrip verification' });
  const text = queryResult.content[0].text;
  assert(text.includes('roundtrip verification'), `Expected remembered content in query results, got: ${text.slice(0, 200)}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 4: handleReflect formatting ───
console.log('Test 4: handleReflect formatting');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);
  insertChunk(db, { content: 'old fact about something', chunkType: 'inferred', confidence: 0.5, createdAt: new Date(Date.now() - 200 * 86400000).toISOString() });
  insertChunk(db, { content: 'recent fact', chunkType: 'fact', confidence: 1.0 });

  const result = handleReflect(db, { dryRun: true });
  const text = result.content[0].text;
  assert(text.includes('[DRY RUN]'), 'Expected DRY RUN prefix');
  assert(text.includes('Decayed:'), 'Expected Decayed count');
  assert(text.includes('Reinforced:'), 'Expected Reinforced count');
  assert(text.includes('Marked stale:'), 'Expected Marked stale count');
  assert(text.includes('Contradictions:'), 'Expected Contradictions count');
  assert(text.includes('Archived:'), 'Expected Archived count');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 5: handleStatus formatting ───
console.log('Test 5: handleStatus formatting');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);
  insertChunk(db, { content: 'some memory content', filePath: 'MEMORY.md' });
  insertChunk(db, { content: 'daily log entry', filePath: 'memory/2026-02-20.md' });

  const result = handleStatus(db);
  const text = result.content[0].text;
  assert(text.includes('Files indexed:'), 'Expected file count');
  assert(text.includes('Total chunks:'), 'Expected chunk count');
  assert(text.includes('MEMORY.md'), 'Expected file list');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 6: Error handling on bad query ───
console.log('Test 6: Error handling on bad query');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  const result = handleQuery(db, ws, { query: '' });
  const text = result.content[0].text;
  assert(text === 'No results found.', `Expected graceful empty for blank query, got: ${text}`);
  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 7: handleIndex formatting ───
console.log('Test 7: handleIndex formatting');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  const memDir = path.join(ws, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '2026-02-20.md'), '# Session Log — 2026-02-20\n\n- [fact] Test indexing\n', 'utf-8');

  const result = handleIndex(db, ws, { force: true }, null);
  const text = result.content[0].text;
  assert(text.includes('Indexed:'), 'Expected Indexed count');
  assert(text.includes('Skipped:'), 'Expected Skipped count');
  assert(text.includes('Total:'), 'Expected Total count');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 8: indexSingleFile — targeted re-index ───
console.log('Test 8: indexSingleFile — targeted re-index');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  // Create two memory files
  const memDir = path.join(ws, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '2026-02-19.md'), '# Session Log — 2026-02-19\n\n- [fact] Old fact\n', 'utf-8');
  fs.writeFileSync(path.join(memDir, '2026-02-20.md'), '# Session Log — 2026-02-20\n\n- [fact] New fact\n', 'utf-8');

  // Full index first
  indexWorkspace(db, ws, { force: true });
  const beforeCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;

  // Append to one file and re-index just that file
  fs.appendFileSync(path.join(memDir, '2026-02-20.md'), '- [confirmed] Added fact after initial index\n', 'utf-8');
  const result = indexSingleFile(db, ws, path.join(memDir, '2026-02-20.md'));
  assert(result.skipped === false, 'Should have re-indexed the changed file');

  // Verify the new content is indexed
  const { recall } = require('../lib/recall');
  const results = recall(db, 'Added fact after initial', { workspace: ws });
  assert(results.length > 0, `Expected to find newly indexed content, got ${results.length}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 9: indexSingleFile — skips unchanged ───
console.log('Test 9: indexSingleFile — skips unchanged');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  const memDir = path.join(ws, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '2026-02-20.md'), '# Session Log — 2026-02-20\n\n- [fact] Static fact\n', 'utf-8');

  // Index once
  indexSingleFile(db, ws, path.join(memDir, '2026-02-20.md'));

  // Index again without changes — should skip
  const result = indexSingleFile(db, ws, path.join(memDir, '2026-02-20.md'));
  assert(result.skipped === true, 'Should have skipped unchanged file');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 10: handleIndex with config-driven extra files ───
console.log('Test 10: handleIndex with config-driven extra files');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  // Create an agents dir with a .md file (not in default discovery)
  const agentsDir = path.join(ws, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'researcher.md'), '# Researcher Agent\n\n- [fact] Handles deep research tasks\n', 'utf-8');

  // Also create a standard memory file
  const memDir = path.join(ws, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '2026-02-20.md'), '# Session Log\n\n- [fact] Daily log\n', 'utf-8');

  // Index WITHOUT config — agents file should NOT be indexed
  const result1 = handleIndex(db, ws, { force: true }, null);
  const stats1 = db.prepare('SELECT COUNT(*) as n FROM files').get().n;

  // Now index WITH config including agents glob
  const config = { ...DEFAULTS, includeGlobs: ['agents/*.md'] };
  const result2 = handleIndex(db, ws, { force: true }, config);
  const text2 = result2.content[0].text;

  // Verify agents file is now indexed
  const agentChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path LIKE 'agents/%'").get().n;
  assert(agentChunks > 0, `Expected agent chunks after config index, got ${agentChunks}`);
  assert(text2.includes('Indexed:'), 'Config index should report indexed count');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 11: handleIndex with config explicit include ───
console.log('Test 11: handleIndex with config explicit include');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  // Create CLAUDE.md at workspace root
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Master Config\n\n- [confirmed] Default stack is React 19\n', 'utf-8');

  const config = { ...DEFAULTS, include: ['CLAUDE.md'] };
  const result = handleIndex(db, ws, { force: true }, config);

  const claudeChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'CLAUDE.md'").get().n;
  assert(claudeChunks > 0, `Expected CLAUDE.md chunks, got ${claudeChunks}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 12: handleIndex without config still works ───
console.log('Test 12: handleIndex without config still works (backward compat)');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  const memDir = path.join(ws, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '2026-02-20.md'), '# Test\n\n- [fact] Works without config\n', 'utf-8');

  // null config = no extra files, should still index defaults
  const result = handleIndex(db, ws, { force: true }, null);
  const text = result.content[0].text;
  assert(text.includes('Indexed: 1'), `Expected 1 indexed, got: ${text}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
