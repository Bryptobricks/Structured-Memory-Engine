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

  const mixed = extractEntities('@alex uses **creatine** daily');
  assert(mixed.includes('@alex'), 'Mixed: should find @alex');
  assert(mixed.includes('creatine'), 'Mixed: should find creatine');
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

// ─── Test 6: indexWorkspace with fileTypeDefaults ───
console.log('Test 6: indexWorkspace with fileTypeDefaults');
{
  const dir = makeTempDir();
  try {
    // MEMORY.md with no inline tags — should get file-level default
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Long-Term Memory\n\nAlex prefers dark themes and monospace fonts.\n');

    const db = createDb();
    const ftd = { 'MEMORY.md': 'confirmed' };
    indexWorkspace(db, dir, { force: true, fileTypeDefaults: ftd });

    const chunks = db.prepare("SELECT chunk_type, confidence FROM chunks WHERE file_path = 'MEMORY.md'").all();
    assert(chunks.length > 0, `Should have MEMORY.md chunks, got ${chunks.length}`);
    assert(chunks.every(c => c.chunk_type === 'confirmed'), `All MEMORY.md chunks should be confirmed, got ${chunks.map(c => c.chunk_type)}`);
    assert(chunks.every(c => c.confidence === 1.0), `All MEMORY.md chunks should have confidence 1.0`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 7: indexWorkspace — inline tag overrides file default ───
console.log('Test 7: indexWorkspace — inline tag overrides file default');
{
  const dir = makeTempDir();
  try {
    // File default = confirmed, but one chunk has [inferred] inline
    fs.writeFileSync(path.join(dir, 'MEMORY.md'),
      '# Preferences\n\n- [confirmed] Alex uses dark mode\n\n# Guesses\n\n- [inferred] Alex prefers warm lighting\n');

    const db = createDb();
    const ftd = { 'MEMORY.md': 'confirmed' };
    indexWorkspace(db, dir, { force: true, fileTypeDefaults: ftd });

    const chunks = db.prepare("SELECT chunk_type, confidence, content FROM chunks WHERE file_path = 'MEMORY.md' ORDER BY line_start").all();

    // Chunk with [confirmed] tag — should stay confirmed (inline matches file default)
    const confirmedChunk = chunks.find(c => c.content.includes('dark mode'));
    assert(confirmedChunk && confirmedChunk.chunk_type === 'confirmed', 'Confirmed inline should stay confirmed');

    // Chunk with [inferred] tag — inline overrides file default
    const inferredChunk = chunks.find(c => c.content.includes('warm lighting'));
    assert(inferredChunk && inferredChunk.chunk_type === 'inferred', `Inferred inline should override file default, got ${inferredChunk ? inferredChunk.chunk_type : 'missing'}`);
    assert(inferredChunk && inferredChunk.confidence === 0.7, `Inferred confidence should be 0.7, got ${inferredChunk ? inferredChunk.confidence : 'missing'}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 8: indexWorkspace — no fileTypeDefaults keeps raw ───
console.log('Test 8: indexWorkspace — no fileTypeDefaults preserves raw behavior');
{
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'USER.md'), '# User\n\nSome content without tags\n');

    const db = createDb();
    indexWorkspace(db, dir, { force: true });

    const chunks = db.prepare("SELECT chunk_type FROM chunks WHERE file_path = 'USER.md'").all();
    assert(chunks.length > 0, 'Should have USER.md chunks');
    assert(chunks.every(c => c.chunk_type === 'raw'), `Without fileTypeDefaults, chunks should be raw, got ${chunks.map(c => c.chunk_type)}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 9: indexWorkspace — orphan file cleanup ───
console.log('Test 9: indexWorkspace — orphan file cleanup');
{
  const dir = makeTempDir();
  try {
    // Create two files and index
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory\n\nSome facts\n');
    fs.writeFileSync(path.join(dir, 'USER.md'), '# User\n\nUser info\n');

    const db = createDb();
    const r1 = indexWorkspace(db, dir, { force: true });
    assert(r1.indexed === 2, `Should index 2 files, got ${r1.indexed}`);
    assert(r1.cleaned === 0, `No orphans on first run, got ${r1.cleaned}`);

    const filesBefore = db.prepare('SELECT COUNT(*) as n FROM files').get().n;
    assert(filesBefore === 2, `Should have 2 file entries, got ${filesBefore}`);

    // Delete USER.md from disk, re-index
    fs.unlinkSync(path.join(dir, 'USER.md'));
    const r2 = indexWorkspace(db, dir, { force: true });
    assert(r2.cleaned === 1, `Should clean 1 orphan, got ${r2.cleaned}`);

    // Verify DB no longer has USER.md
    const filesAfter = db.prepare('SELECT COUNT(*) as n FROM files').get().n;
    assert(filesAfter === 1, `Should have 1 file entry after cleanup, got ${filesAfter}`);
    const userChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'USER.md'").get().n;
    assert(userChunks === 0, `Should have 0 USER.md chunks after cleanup, got ${userChunks}`);

    // MEMORY.md still intact
    const memChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'MEMORY.md'").get().n;
    assert(memChunks > 0, `MEMORY.md chunks should survive cleanup, got ${memChunks}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 10: Heading-only chunks skipped ───
console.log('Test 10: Heading-only chunks skipped');
{
  // "## Transcript" alone should be skipped (< 20 chars substantive)
  const headingOnly = chunkMarkdown('## Transcript\n\n## Another Heading\nThis has real content that should be kept.');
  // First section is heading-only → skipped. Second has content → kept.
  const transcriptChunks = headingOnly.filter(c => c.content.includes('## Transcript') && !c.content.includes('real content'));
  assert(transcriptChunks.length === 0, `Heading-only "## Transcript" should be skipped, found ${transcriptChunks.length}`);
  const keptChunks = headingOnly.filter(c => c.content.includes('real content'));
  assert(keptChunks.length === 1, `Content chunk should be kept, found ${keptChunks.length}`);
}

// ─── Test 11: Heading with trivial content skipped ───
console.log('Test 11: Heading with trivial content skipped');
{
  const shortContent = chunkMarkdown('## Section\nOK\n\n## Real Section\nThis is a paragraph with enough content to be useful and indexed properly.');
  // "OK" is only 2 chars after stripping heading → should be skipped (< 5 char threshold)
  const okChunks = shortContent.filter(c => c.content.trim() === '## Section\nOK');
  assert(okChunks.length === 0, `Heading with trivial content should be skipped, found ${okChunks.length}`);
  assert(shortContent.length >= 1, `Should keep at least the real section, got ${shortContent.length}`);
}

// ─── Test 12: Normal chunks not affected by heading-only filter ───
console.log('Test 12: Normal chunks not affected by heading-only filter');
{
  const normal = chunkMarkdown('# Key Facts\n\n- The sky is blue and has many interesting properties we should discuss\n\n# Decisions\n\n- Chose React for frontend because it has the best ecosystem and community support');
  assert(normal.length === 2, `Normal content should produce 2 chunks, got ${normal.length}`);
  assert(normal[0].heading === 'Key Facts', `First chunk heading should be "Key Facts", got "${normal[0].heading}"`);
  assert(normal[1].heading === 'Decisions', `Second chunk heading should be "Decisions", got "${normal[1].heading}"`);
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
