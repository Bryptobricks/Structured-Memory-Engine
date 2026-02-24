#!/usr/bin/env node
/**
 * Tests for indexer.js — entity extraction, markdown chunking, file discovery, indexing pipeline.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SCHEMA, insertChunks } = require('../lib/store');
const { extractEntities, chunkMarkdown, discoverFiles, indexWorkspace } = require('../lib/indexer');

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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sme-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Test 1: extractEntities ───
console.log('Test 1: extractEntities');
{
  const mentions = extractEntities('Talked to @alice and @bob today');
  assert(mentions.includes('@alice'), 'Should extract @alice');
  assert(mentions.includes('@bob'), 'Should extract @bob');

  const bold = extractEntities('Uses **magnesium** and **zinc** daily');
  assert(bold.includes('magnesium'), 'Should extract bold magnesium');
  assert(bold.includes('zinc'), 'Should extract bold zinc');

  const empty = extractEntities('');
  assert(empty.length === 0, 'Empty input → empty array');

  const noEntities = extractEntities('Just a plain sentence with no special formatting');
  assert(noEntities.length === 0, `No false positives, got ${noEntities.length}`);

  const mixed = extractEntities('@jb uses **bromantane** sublingual');
  assert(mixed.includes('@jb'), 'Mixed: should find @jb');
  assert(mixed.includes('bromantane'), 'Mixed: should find bromantane');
  assert(mixed.length === 2, `Mixed: exactly 2 entities, got ${mixed.length}`);
}

// ─── Test 2: chunkMarkdown ───
console.log('Test 2: chunkMarkdown');
{
  // Single paragraph — one chunk
  const single = chunkMarkdown('Just one paragraph of text.');
  assert(single.length === 1, `Single paragraph = 1 chunk, got ${single.length}`);
  assert(single[0].heading === null, 'No heading for plain text');

  // Heading-triggered flush
  const withHeadings = chunkMarkdown('# First\nContent A\n# Second\nContent B');
  assert(withHeadings.length === 2, `Two headings = 2 chunks, got ${withHeadings.length}`);
  assert(withHeadings[0].heading === 'First', `First heading, got: ${withHeadings[0].heading}`);
  assert(withHeadings[1].heading === 'Second', `Second heading, got: ${withHeadings[1].heading}`);

  // Multiple heading levels
  const mixed = chunkMarkdown('## Section A\nAlpha\n### Sub B\nBravo\n## Section C\nCharlie');
  assert(mixed.length === 3, `Three sections = 3 chunks, got ${mixed.length}`);

  // Line numbers correct
  const lines = chunkMarkdown('Line 1\n# Heading\nLine 3\nLine 4');
  assert(lines[0].lineStart === 1, `First chunk starts at line 1, got ${lines[0].lineStart}`);
  assert(lines[1].lineStart === 2, `Second chunk starts at line 2, got ${lines[1].lineStart}`);
}

// ─── Test 3: pushChunk splitting (via chunkMarkdown) ───
console.log('Test 3: pushChunk splitting');
{
  // Small content — 1 chunk
  const small = chunkMarkdown('# Title\nShort content here');
  assert(small.length === 1, `Small content = 1 chunk, got ${small.length}`);

  // Large content (>2000 chars) split by paragraph
  const longPara1 = 'A'.repeat(1200);
  const longPara2 = 'B'.repeat(1200);
  const bigContent = `# Big Section\n${longPara1}\n\n${longPara2}`;
  const big = chunkMarkdown(bigContent);
  assert(big.length >= 2, `Large content should split into 2+ chunks, got ${big.length}`);

  // Heading preserved on split chunks
  for (const chunk of big) {
    assert(chunk.heading === 'Big Section', `Split chunk should preserve heading, got: ${chunk.heading}`);
  }
}

// ─── Test 4: discoverFiles ───
console.log('Test 4: discoverFiles');
{
  const dir = makeTempDir();
  try {
    // Create default files
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory');
    fs.writeFileSync(path.join(dir, 'USER.md'), '# User');
    fs.writeFileSync(path.join(dir, 'TOOLS.md'), '# Tools');

    const defaults = discoverFiles(dir);
    assert(defaults.length === 3, `Should find 3 default files, got ${defaults.length}`);

    // memory/ subdirectory
    fs.mkdirSync(path.join(dir, 'memory'));
    fs.writeFileSync(path.join(dir, 'memory', '2026-01-01.md'), '# Day log');
    fs.writeFileSync(path.join(dir, 'memory', '2026-01-02.md'), '# Day log 2');

    const withMemory = discoverFiles(dir);
    assert(withMemory.length === 5, `Should find 5 files (3 default + 2 memory), got ${withMemory.length}`);

    // Custom include
    fs.writeFileSync(path.join(dir, 'custom.md'), '# Custom');
    const withCustom = discoverFiles(dir, { include: ['custom.md'] });
    assert(withCustom.length === 6, `Should find 6 files with custom include, got ${withCustom.length}`);

    // Non-existent include silently skipped
    const withMissing = discoverFiles(dir, { include: ['does-not-exist.md'] });
    assert(withMissing.length === 5, `Non-existent include should be skipped, got ${withMissing.length}`);
  } finally {
    cleanup(dir);
  }
}

// ─── Test 5: indexWorkspace pipeline ───
console.log('Test 5: indexWorkspace pipeline');
{
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Key Facts\n\n- [fact] The sky is blue\n\n# Confirmed\n\n- [confirmed] Water is wet\n\n# Decisions\n\n- Chose React for frontend');
    fs.writeFileSync(path.join(dir, 'USER.md'), '# User\n\nJust a normal user file.');

    const db = createDb();

    // First index
    const r1 = indexWorkspace(db, dir, { force: false });
    assert(r1.indexed === 2, `Should index 2 files, got ${r1.indexed}`);
    assert(r1.skipped === 0, `Should skip 0 on first run, got ${r1.skipped}`);

    const chunkCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
    assert(chunkCount > 0, `Should have chunks after indexing, got ${chunkCount}`);

    // Skip unchanged (force=false)
    const r2 = indexWorkspace(db, dir, { force: false });
    assert(r2.skipped === 2, `Should skip 2 unchanged files, got ${r2.skipped}`);
    assert(r2.indexed === 0, `Should index 0 on unchanged run, got ${r2.indexed}`);

    // Re-index with force=true
    const r3 = indexWorkspace(db, dir, { force: true });
    assert(r3.indexed === 2, `Force should re-index 2 files, got ${r3.indexed}`);

    // Fact-upgrade: tagged facts should set chunk_type
    const facts = db.prepare("SELECT * FROM chunks WHERE chunk_type = 'fact'").all();
    assert(facts.length >= 1, `Should have at least 1 fact-typed chunk, got ${facts.length}`);

    const confirmed = db.prepare("SELECT * FROM chunks WHERE chunk_type = 'confirmed'").all();
    assert(confirmed.length >= 1, `Should have at least 1 confirmed-typed chunk, got ${confirmed.length}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
