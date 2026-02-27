#!/usr/bin/env node
/**
 * Tests for CIL — Context Intelligence Layer (lib/context.js)
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
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
  const result = db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale)
    VALUES (?, ?, ?, 1, 10, ?, ?, ?, ?, ?, ?, 0, NULL, 0)`).run(
    filePath, heading, content, entities, chunkType, confidence, createdAt || now, now, fileWeight
  );
  return result.lastInsertRowid;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function seedFixture(db) {
  // Health protocol — active
  insertChunk(db, { content: 'Bromantane 25mg sublingual started Feb 23. Day 1: 6hr peak focus, appetite suppression, calm tunnel vision.', heading: 'Bromantane Tracking', entities: JSON.stringify(['bromantane']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(4), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Health protocol — superseded
  insertChunk(db, { content: 'Retatrutide currently 1.75mg per week, will reduce to 1.5mg.', heading: 'Health', entities: JSON.stringify(['retatrutide']), chunkType: 'fact', confidence: 0.6, createdAt: daysAgo(17), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Health protocol — current
  insertChunk(db, { content: 'Retatrutide reduced to 1.5mg per week as of Feb 16. Weight: 197 lbs.', heading: 'Health', entities: JSON.stringify(['retatrutide']), chunkType: 'confirmed', confidence: 1.0, createdAt: daysAgo(11), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Work — decision
  insertChunk(db, { content: 'MovePosition will be the primary lending protocol on Movement. Ownership discussions underway — need greater than 51% equity.', heading: 'In-House DeFi', entities: JSON.stringify(['MovePosition', 'Movement']), chunkType: 'decision', confidence: 0.95, createdAt: daysAgo(3), filePath: 'memory/2026-02-24.md' });
  // Work — action item
  insertChunk(db, { content: 'Send Jason fund flow doc with pool health plan, incentive APRs, duration, contingency.', heading: 'Action Items', entities: JSON.stringify(['Jason', 'Avalon']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(3), filePath: 'memory/2026-02-24.md' });
  // Personal — preference
  insertChunk(db, { content: 'JB prefers minimal, solid, dark aesthetic. Warm, dim, red-amber lighting tones.', heading: 'Preferences', entities: JSON.stringify(['JB']), chunkType: 'preference', confidence: 1.0, createdAt: daysAgo(43), filePath: 'USER.md', fileWeight: 1.3 });
  // Old event
  insertChunk(db, { content: 'ETHDenver trip Feb 17-21. Hotel: Grand Hyatt Denver.', heading: 'ETHDenver', entities: JSON.stringify(['ETHDenver']), chunkType: 'fact', confidence: 0.8, createdAt: daysAgo(16), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Technical — recent
  insertChunk(db, { content: 'OpenClaw 200K context cap bug. Opus 4.6 listed as 1M but API enforces 200K. Missing beta header.', heading: 'System', entities: JSON.stringify(['OpenClaw']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(1), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Crypto — portfolio
  insertChunk(db, { content: 'Portfolio framework: 80/15/5 crypto/equities/venture. Net worth $2.34M. 67% stabled.', heading: 'Portfolio', entities: JSON.stringify(['portfolio']), chunkType: 'confirmed', confidence: 1.0, createdAt: daysAgo(3), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Generic daily noise
  insertChunk(db, { content: 'Checked email. Nothing urgent. Calendar clear until 3pm.', heading: null, entities: '[]', chunkType: 'raw', confidence: 1.0, createdAt: daysAgo(2), filePath: 'memory/2026-02-25.md' });
}

// ─── Test 1: Bromantane query ───
console.log('Test 1: "How\'s the bromantane experiment going?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, "How's the bromantane experiment going?");
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Bromantane'), `Expected Bromantane chunk ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  // Retatrutide should not be in top 3
  const top3Contents = result.chunks.slice(0, 3).map(c => c.content).join(' ');
  assert(!top3Contents.toLowerCase().includes('retatrutide'), 'Retatrutide should not be in top 3 for bromantane query');
  assert(result.text.includes('## Recalled Context'), 'Output should have Recalled Context header');
  assert(result.tokenEstimate > 0, `Token estimate should be > 0, got ${result.tokenEstimate}`);
  db.close();
}

// ─── Test 2: Lending protocol decision ───
console.log('Test 2: "What did we decide about the lending protocol?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'What did we decide about the lending protocol?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('MovePosition'), `Expected MovePosition decision ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  db.close();
}

// ─── Test 3: Entity match — Jason ───
console.log('Test 3: "What do I need to send Jason?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'What do I need to send Jason?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Jason'), `Expected Jason action item ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  db.close();
}

// ─── Test 4: Retatrutide — current dose outranks old ───
console.log('Test 4: "What\'s my current retatrutide dose?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, "What's my current retatrutide dose?");
  assert(result.chunks.length >= 2, `Expected at least 2 chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('1.5mg'), `Expected 1.5mg (current) ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  // The superseded 1.75mg should rank lower
  const idx175 = result.chunks.findIndex(c => c.content.includes('1.75mg'));
  if (idx175 >= 0) {
    assert(idx175 > 0, `Superseded 1.75mg should not be #1 (found at index ${idx175})`);
  }
  db.close();
}

// ─── Test 5: Portfolio query ───
console.log('Test 5: "Tell me about my portfolio"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'Tell me about my portfolio');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Portfolio'), `Expected Portfolio chunk ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  // ETHDenver should not appear
  const allContents = result.chunks.map(c => c.content).join(' ');
  assert(!allContents.includes('ETHDenver'), 'ETHDenver should not appear in portfolio query');
  db.close();
}

// ─── Test 6: Empty string ───
console.log('Test 6: Empty query returns empty');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, '');
  assert(result.text === '', `Expected empty text, got length ${result.text.length}`);
  assert(result.chunks.length === 0, `Expected 0 chunks, got ${result.chunks.length}`);
  assert(result.tokenEstimate === 0, `Expected 0 tokens, got ${result.tokenEstimate}`);
  db.close();
}

// ─── Test 7: Irrelevant query returns empty or minimal ───
console.log('Test 7: "What\'s the weather like?" — no relevant memory');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, "What's the weather like?");
  // Should return nothing or very few low-relevance results
  assert(result.chunks.length <= 2, `Expected 0-2 chunks for irrelevant query, got ${result.chunks.length}`);
  db.close();
}

// ─── Test 8: Lighting preferences with entity match ───
console.log('Test 8: "JB\'s lighting preferences"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, "JB's lighting preferences");
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('lighting'), `Expected lighting preference ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  db.close();
}

// ─── Test 9: Contradiction flagging ───
console.log('Test 9: Contradictions flagged in output');
{
  const db = createDb();
  // Insert contradictory chunks + a contradiction record
  const id1 = insertChunk(db, { heading: 'Protocol', content: 'takes bromantane sublingual daily morning protocol for focus energy', filePath: 'memory/2026-01-01.md', chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(60) });
  const id2 = insertChunk(db, { heading: 'Protocol', content: 'stopped bromantane sublingual daily morning protocol due tolerance', filePath: 'memory/2026-02-01.md', chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(10) });
  // Manually insert contradiction record
  db.prepare('INSERT INTO contradictions (chunk_id_old, chunk_id_new, reason, created_at) VALUES (?, ?, ?, ?)').run(
    Math.min(id1, id2), Math.max(id1, id2), 'Shared terms: bromantane, sublingual; negation detected', new Date().toISOString()
  );

  const result = getRelevantContext(db, 'bromantane protocol morning focus');
  assert(result.chunks.length >= 2, `Expected at least 2 chunks, got ${result.chunks.length}`);
  assert(result.text.includes('contradictions'), `Expected contradiction flag in output, text: ${result.text.slice(-200)}`);
  db.close();
}

// ─── Test 10: Token budget enforcement ───
console.log('Test 10: Token budget enforcement');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'bromantane retatrutide portfolio lending protocol', { maxTokens: 200 });
  assert(result.tokenEstimate <= 200, `Expected <= 200 tokens, got ${result.tokenEstimate}`);
  assert(result.chunks.length <= 3, `Expected max 3 chunks with tight budget, got ${result.chunks.length}`);
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
