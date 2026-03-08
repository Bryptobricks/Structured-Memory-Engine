#!/usr/bin/env node
/**
 * Tests for v8.0 Automated Memory Promotion (Item 4)
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { findPromotionCandidates, generatePromotionReport } = require('../lib/promote');

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
  return db;
}

function insertChunk(db, { filePath, content, chunkType = 'fact', confidence = 1.0, valueScore = 0.8, valueLabel = 'core', stale = 0 }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, stale, value_score, value_label)
    VALUES (?, ?, ?, 1, 5, '[]', ?, ?, ?, ?, 1.0, 0, ?, ?, ?)`).run(
    filePath, null, content, chunkType, confidence, now, now, stale, valueScore, valueLabel
  );
}

// ─── Test 1: Core fact in daily file → candidate ───
console.log('Test 1: Core fact in daily file → candidate');
{
  const db = createDb();
  insertChunk(db, { filePath: 'memory/2026-03-01.md', content: 'JB prefers React 19 with TypeScript for all new projects', chunkType: 'preference', valueScore: 0.85, valueLabel: 'core' });
  const result = findPromotionCandidates(db, '/tmp');
  assert(result.autoPromote.length === 1, `Should find 1 candidate, got ${result.autoPromote.length}`);
  assert(result.autoPromote[0].content.includes('React 19'), 'Candidate should be the preference chunk');
  db.close();
}

// ─── Test 2: Same fact in MEMORY.md → skipped (dedup) ───
console.log('Test 2: Same fact in MEMORY.md → skipped');
{
  const db = createDb();
  insertChunk(db, { filePath: 'MEMORY.md', content: 'JB prefers React 19 with TypeScript for all new projects', chunkType: 'confirmed', valueScore: 0.9, valueLabel: 'core' });
  insertChunk(db, { filePath: 'memory/2026-03-01.md', content: 'JB prefers React 19 with TypeScript for all new projects', chunkType: 'preference', valueScore: 0.85, valueLabel: 'core' });
  const result = findPromotionCandidates(db, '/tmp');
  assert(result.autoPromote.length === 0, `Should skip duplicate, got ${result.autoPromote.length}`);
  assert(result.skipped.length === 1, `Should mark 1 as skipped, got ${result.skipped.length}`);
  db.close();
}

// ─── Test 3: Similar fact → review needed or skipped ───
console.log('Test 3: Similar fact → review needed or skipped');
{
  const db = createDb();
  // Use content that's clearly similar but not identical — enough shared terms to trigger similarity
  insertChunk(db, { filePath: 'MEMORY.md', content: 'JB prefers React TypeScript Vite Tailwind frontend development stack for building web applications and dashboards', chunkType: 'confirmed', valueScore: 0.9, valueLabel: 'core' });
  insertChunk(db, { filePath: 'memory/2026-03-01.md', content: 'JB prefers React TypeScript Vite Tailwind frontend development stack for building new web projects and tools', chunkType: 'preference', valueScore: 0.85, valueLabel: 'core' });
  const result = findPromotionCandidates(db, '/tmp');
  // High overlap should flag as review or skip, not auto-promote
  assert(result.reviewNeeded.length > 0 || result.skipped.length > 0,
    `Similar content should be review/skipped, got auto=${result.autoPromote.length} review=${result.reviewNeeded.length} skip=${result.skipped.length}`);
  db.close();
}

// ─── Test 4: Raw/noise chunks → never considered ───
console.log('Test 4: Raw/noise chunks → never considered');
{
  const db = createDb();
  insertChunk(db, { filePath: 'memory/2026-03-01.md', content: 'Session started at 10am, auto-indexed 5 files', chunkType: 'raw', valueScore: 0.1, valueLabel: 'noise' });
  insertChunk(db, { filePath: 'memory/2026-03-01.md', content: 'Config: port 3000, debug mode off', chunkType: 'raw', valueScore: 0.05, valueLabel: 'junk' });
  const result = findPromotionCandidates(db, '/tmp');
  assert(result.autoPromote.length === 0, `Raw/noise chunks should not be candidates, got ${result.autoPromote.length}`);
  db.close();
}

// ─── Test 5: Respects maxCandidates cap ───
console.log('Test 5: Respects maxCandidates cap');
{
  const db = createDb();
  for (let i = 0; i < 10; i++) {
    insertChunk(db, { filePath: `memory/2026-03-0${i % 9 + 1}.md`, content: `Important decision number ${i} about project architecture variant ${i}`, chunkType: 'decision', valueScore: 0.9, valueLabel: 'core' });
  }
  const result = findPromotionCandidates(db, '/tmp', { maxCandidates: 3 });
  assert(result.autoPromote.length <= 3, `Should cap at 3, got ${result.autoPromote.length}`);
  db.close();
}

// ─── Test 6: generatePromotionReport works ───
console.log('Test 6: generatePromotionReport');
{
  const result = {
    autoPromote: [{ chunk_type: 'fact', content: 'Test fact content', file_path: 'memory/2026-03-01.md', value_score: 0.85 }],
    reviewNeeded: [{ chunk_type: 'preference', content: 'Test pref', similarTo: 'Existing pref', similarity: 0.6 }],
    skipped: [{ reason: 'already_in_memory' }],
  };
  const report = generatePromotionReport(result);
  assert(report.includes('Auto-promote: 1'), 'Report should show auto-promote count');
  assert(report.includes('Needs review: 1'), 'Report should show review count');
  assert(report.includes('Skipped'), 'Report should show skipped count');
}

// ─── Test 7: Non-daily files excluded ───
console.log('Test 7: Non-daily files excluded');
{
  const db = createDb();
  insertChunk(db, { filePath: 'TOOLS.md', content: 'Important tool configuration for deployment', chunkType: 'fact', valueScore: 0.9, valueLabel: 'core' });
  const result = findPromotionCandidates(db, '/tmp');
  assert(result.autoPromote.length === 0, `Non-daily files should not be candidates, got ${result.autoPromote.length}`);
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
