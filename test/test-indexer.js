#!/usr/bin/env node
/**
 * Tests for indexer.js — entity extraction, markdown chunking, file discovery, indexing pipeline.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SCHEMA, insertChunks } = require('../lib/store');
const { extractEntities, chunkMarkdown, discoverFiles, indexWorkspace, classifyChunk, classifySourceType, classifyDomain } = require('../lib/indexer');

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
  try { db.exec('ALTER TABLE chunks ADD COLUMN priority TEXT DEFAULT \'medium\''); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN referenced_date TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN relative_offset REAL'); } catch (_) {}
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

// ─── Test 13: extractEntities — acronyms ───
console.log('Test 13: extractEntities — acronyms');
{
  const entities = extractEntities('Working on the SME and GETIS projects using the API');
  assert(entities.includes('SME'), `Should extract SME, got ${entities}`);
  assert(entities.includes('GETIS'), `Should extract GETIS, got ${entities}`);
  assert(entities.includes('API'), `Should extract API, got ${entities}`);
  // Should skip common non-entity uppercase (OK, AM, PM etc. if present)
  const skip = extractEntities('OK fine, AM session at 10 PM');
  assert(!skip.includes('OK'), 'Should skip OK');
  assert(!skip.includes('AM'), 'Should skip AM');
  assert(!skip.includes('PM'), 'Should skip PM');
}

// ─── Test 14: extractEntities — tickers ───
console.log('Test 14: extractEntities — tickers');
{
  const entities = extractEntities('Bought $BTC and $ETH, considering $SOL');
  assert(entities.includes('$BTC'), `Should extract $BTC, got ${entities}`);
  assert(entities.includes('$ETH'), `Should extract $ETH, got ${entities}`);
  assert(entities.includes('$SOL'), `Should extract $SOL, got ${entities}`);
}

// ─── Test 15: extractEntities — quoted terms ───
console.log('Test 15: extractEntities — quoted terms');
{
  const entities = extractEntities('Switched to "dark mode" and configured "JetBrains Mono" font');
  assert(entities.includes('dark mode'), `Should extract "dark mode", got ${entities}`);
  assert(entities.includes('JetBrains Mono'), `Should extract "JetBrains Mono", got ${entities}`);
  // Short quotes (<3 chars) should be skipped
  const short = extractEntities('Said "hi" to the team');
  assert(!short.includes('hi'), 'Should skip short quoted terms');
}

// ─── Test 16: extractEntities — URLs ───
console.log('Test 16: extractEntities — URLs');
{
  const entities = extractEntities('Deployed to https://example.com/api and docs at http://docs.example.com');
  assert(entities.some(e => e.includes('example.com/api')), `Should extract URL, got ${entities}`);
  assert(entities.some(e => e.includes('docs.example.com')), `Should extract second URL, got ${entities}`);
}

// ─── Test 17: extractEntities — mixed new + old patterns ───
console.log('Test 17: extractEntities — mixed new + old patterns');
{
  const entities = extractEntities('@alice uses **creatine** for the SME project, tracking $BTC via "DeFi dashboard"');
  assert(entities.includes('@alice'), 'Should still find @mentions');
  assert(entities.includes('creatine'), 'Should still find **bold**');
  assert(entities.includes('SME'), 'Should find acronym');
  assert(entities.includes('$BTC'), 'Should find ticker');
  assert(entities.includes('DeFi dashboard'), 'Should find quoted term');
}

// ─── Test 18: Speaker-turn splitting for oversized transcript chunks ───
console.log('Test 18: Speaker-turn splitting for oversized transcript chunks');
{
  // Build a transcript-style text >2000 chars with speaker turns but no paragraph breaks
  const turn1 = 'Alice: ' + 'This is a really long discussion about architecture. '.repeat(20);
  const turn2 = 'Bob: ' + 'I agree and here are my thoughts on the database design. '.repeat(20);
  const turn3 = 'Alice: ' + 'Great points, let me elaborate on the caching strategy. '.repeat(20);
  const transcript = `# Meeting Notes\n${turn1}\n${turn2}\n${turn3}`;
  assert(transcript.length > 2000, `Transcript should be >2000 chars, got ${transcript.length}`);

  const chunks = chunkMarkdown(transcript);
  assert(chunks.length >= 2, `Should split transcript into 2+ chunks, got ${chunks.length}`);
  // No chunk should exceed MAX_CHUNK (2000) by more than a small margin
  for (const c of chunks) {
    assert(c.content.length <= 2500, `Chunk should not be massively oversized, got ${c.content.length}`);
  }
}

// ─── Test 19: Timestamp-based speaker turns ───
console.log('Test 19: Timestamp-based speaker turns');
{
  const turn1 = '[00:00] Alice: ' + 'Discussion point one about the project scope and timeline. '.repeat(20);
  const turn2 = '[05:30] Bob: ' + 'Response about budget constraints and resource allocation. '.repeat(20);
  const turn3 = '[10:15] Alice: ' + 'Follow-up on the technical implementation details. '.repeat(20);
  const transcript = `# Standup\n${turn1}\n${turn2}\n${turn3}`;

  const chunks = chunkMarkdown(transcript);
  assert(chunks.length >= 2, `Should split timestamped transcript into 2+ chunks, got ${chunks.length}`);
}

// ─── Test 20: Small content not affected by speaker-turn splitting ───
console.log('Test 20: Small content not affected by speaker-turn splitting');
{
  const small = '# Meeting\nAlice: Hello\nBob: Hi there\nAlice: Let\'s discuss the agenda';
  const chunks = chunkMarkdown(small);
  assert(chunks.length === 1, `Small content should stay as 1 chunk, got ${chunks.length}`);
}

// ─── Test 21: indexWorkspace — excludePatterns skips matching files ───
console.log('Test 21: indexWorkspace — excludePatterns skips matching files');
{
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory\n\nImportant facts here.\n');
    fs.writeFileSync(path.join(dir, 'USER.md'), '# User\n\nUser info here.\n');
    fs.mkdirSync(path.join(dir, 'memory'));
    fs.writeFileSync(path.join(dir, 'memory', 'old-spec.md'), '# Old Spec\n\nObsolete spec content.\n');

    const db = createDb();

    // Index with exclusion pattern
    const r = indexWorkspace(db, dir, { force: true, excludePatterns: ['memory/old-spec.md'] });
    assert(r.excluded === 1, `Should exclude 1 file, got ${r.excluded}`);
    assert(r.indexed === 2, `Should index 2 files, got ${r.indexed}`);

    // Verify excluded file has no chunks
    const excludedChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'memory/old-spec.md'").get().n;
    assert(excludedChunks === 0, `Excluded file should have 0 chunks, got ${excludedChunks}`);

    // Verify non-excluded files are indexed
    const memChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'MEMORY.md'").get().n;
    assert(memChunks > 0, `MEMORY.md should have chunks, got ${memChunks}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 22: indexWorkspace — glob excludePatterns ───
console.log('Test 22: indexWorkspace — glob excludePatterns');
{
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory\n\nFacts here.\n');
    fs.mkdirSync(path.join(dir, 'memory'));
    fs.writeFileSync(path.join(dir, 'memory', 'sme-spec-v1.md'), '# Spec V1\n\nOld spec.\n');
    fs.writeFileSync(path.join(dir, 'memory', 'sme-spec-v2.md'), '# Spec V2\n\nOlder spec.\n');
    fs.writeFileSync(path.join(dir, 'memory', '2026-01-01.md'), '# Daily\n\nKeep this.\n');

    const db = createDb();
    const r = indexWorkspace(db, dir, { force: true, excludePatterns: ['memory/sme-*.md'] });
    assert(r.excluded === 2, `Should exclude 2 sme-* files, got ${r.excluded}`);

    const smeChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path LIKE 'memory/sme-%'").get().n;
    assert(smeChunks === 0, `sme-* files should have 0 chunks, got ${smeChunks}`);

    const dailyChunks = db.prepare("SELECT COUNT(*) as n FROM chunks WHERE file_path = 'memory/2026-01-01.md'").get().n;
    assert(dailyChunks > 0, `Daily file should still be indexed, got ${dailyChunks}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 23: classifyChunk — explicit tags ───
console.log('Test 23: classifyChunk — explicit tags');
{
  assert(classifyChunk('[fact] The sky is blue') === 'fact', 'Should classify [fact]');
  assert(classifyChunk('[decision] Use React for frontend') === 'decision', 'Should classify [decision]');
  assert(classifyChunk('[confirmed] Water is wet') === 'confirmed', 'Should classify [confirmed]');
  assert(classifyChunk('[preference] Dark mode always') === 'preference', 'Should classify [preference]');
  assert(classifyChunk('[pref] Monospace fonts') === 'preference', 'Should classify [pref] as preference');
  assert(classifyChunk('[opinion] React is better') === 'opinion', 'Should classify [opinion]');
  assert(classifyChunk('[inferred] Probably likes coffee') === 'inferred', 'Should classify [inferred]');
  assert(classifyChunk('[action_item] Fix the bug') === 'action_item', 'Should classify [action_item]');
  assert(classifyChunk('[system] Internal config') === 'fact', 'Should classify [system] as fact');
  assert(classifyChunk('No tags here, just plain text') === null, 'No tags should return null');
  assert(classifyChunk('Decided to use Postgres for the DB') === null, 'Content heuristics should NOT match');
}

// ─── Test 24: Auto-classify during indexing ───
console.log('Test 24: Auto-classify during indexing');
{
  const dir = makeTempDir();
  try {
    // File with explicit tags but no fileTypeDefaults
    fs.writeFileSync(path.join(dir, 'MEMORY.md'),
      '# Notes\n\n[fact] TypeScript is used for the frontend\n\n# Choices\n\n[decision] Switched to Bun for package management\n\n# Plain\n\nJust some text without any tags\n');

    const db = createDb();
    indexWorkspace(db, dir, { force: true });

    const factChunks = db.prepare("SELECT * FROM chunks WHERE chunk_type = 'fact'").all();
    assert(factChunks.length >= 1, `Should have fact-typed chunk, got ${factChunks.length}`);

    const decisionChunks = db.prepare("SELECT * FROM chunks WHERE chunk_type = 'decision'").all();
    assert(decisionChunks.length >= 1, `Should have decision-typed chunk, got ${decisionChunks.length}`);

    const rawChunks = db.prepare("SELECT * FROM chunks WHERE chunk_type = 'raw'").all();
    assert(rawChunks.length >= 1, `Plain text should remain raw, got ${rawChunks.length}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 25: classifySourceType ───
console.log('Test 25: classifySourceType');
{
  assert(classifySourceType('memory/2025-01-01.md') === 'manual', 'memory/ → manual');
  assert(classifySourceType('ingest/transcript.md') === 'ingested', 'ingest/ → ingested');
  assert(classifySourceType('MEMORY.md') === 'indexed', 'root files → indexed');
  assert(classifySourceType('data/notes.md') === 'indexed', 'data/ → indexed');
}

// ─── Test 26: classifyChunk heuristic decision detection ───
console.log('Test 26: classifyChunk heuristic decision detection');
{
  const result = classifyChunk('We decided to use Postgres and going with the managed tier.');
  assert(result !== null && typeof result === 'object', 'Should return object for heuristic');
  assert(result.type === 'decision', `Should be decision, got ${result.type}`);
  assert(result.confidence === 0.7, `Confidence should be 0.7, got ${result.confidence}`);
  // Single signal — not enough
  const single = classifyChunk('We decided to use Postgres.');
  assert(single === null, 'Single decision signal should not trigger heuristic');
}

// ─── Test 27: classifyChunk heuristic preference detection ───
console.log('Test 27: classifyChunk heuristic preference detection');
{
  const result = classifyChunk('JB prefers dark mode for all editors and terminals.');
  assert(result !== null && typeof result === 'object', 'Should return object for preference');
  assert(result.type === 'preference', `Should be preference, got ${result.type}`);
}

// ─── Test 28: classifyDomain ───
console.log('Test 28: classifyDomain');
{
  assert(classifyDomain('Take 500mg vitamin D and check blood labs', 'notes.md', {}) === 'health', 'Health keywords');
  assert(classifyDomain('Swap ETH for USDC on the dex, check yield farming', 'notes.md', {}) === 'crypto', 'Crypto keywords');
  assert(classifyDomain('Sprint planning meeting, deploy to staging', 'notes.md', {}) === 'work', 'Work keywords');
  assert(classifyDomain('Just some general notes about life', 'notes.md', {}) === 'general', 'No domain match');
  // Config path pattern takes priority
  assert(classifyDomain('random text', 'health/notes.md', { health: ['health/'] }) === 'health', 'Config path pattern');
}

// ─── Test 29: indexWorkspace sets source_type and domain ───
console.log('Test 29: indexWorkspace sets source_type and domain');
{
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Notes\n\nSome indexed content here\n');
    fs.writeFileSync(path.join(dir, 'memory', '2025-01-01.md'), '# Daily\n\nTook 500mg vitamin D supplement and checked blood labs\n');

    const db = createDb();
    indexWorkspace(db, dir, { force: true });

    const indexed = db.prepare("SELECT * FROM chunks WHERE source_type = 'indexed'").all();
    assert(indexed.length >= 1, `Should have indexed chunks, got ${indexed.length}`);

    const manual = db.prepare("SELECT * FROM chunks WHERE source_type = 'manual'").all();
    assert(manual.length >= 1, `Should have manual chunks, got ${manual.length}`);

    // Domain classification
    const health = db.prepare("SELECT * FROM chunks WHERE domain = 'health'").all();
    assert(health.length >= 1, `Should have health-domain chunk, got ${health.length}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Test 30: classifyChunk heuristic in indexing pipeline ───
console.log('Test 30: classifyChunk heuristic in indexing pipeline');
{
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'),
      '# Decisions\n\nWe decided to use Bun and going with the latest version. Committed to TypeScript.\n\n# Prefs\n\nJB prefers dark mode for everything.\n');

    const db = createDb();
    indexWorkspace(db, dir, { force: true });

    const decisions = db.prepare("SELECT * FROM chunks WHERE chunk_type = 'decision'").all();
    assert(decisions.length >= 1, `Should have heuristic decision chunk, got ${decisions.length}`);

    const prefs = db.prepare("SELECT * FROM chunks WHERE chunk_type = 'preference'").all();
    assert(prefs.length >= 1, `Should have heuristic preference chunk, got ${prefs.length}`);

    // Heuristic chunks should have 0.7 confidence
    const heuristic = db.prepare("SELECT * FROM chunks WHERE confidence = 0.7").all();
    assert(heuristic.length >= 1, `Should have chunks with 0.7 confidence, got ${heuristic.length}`);

    db.close();
  } finally {
    cleanup(dir);
  }
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
