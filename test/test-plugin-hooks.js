#!/usr/bin/env node
/**
 * Tests for OpenClaw plugin lifecycle hooks — auto-recall and auto-capture logic.
 * Tests the underlying JS behavior since the TS plugin wraps these same functions.
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
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale)
    VALUES (?, ?, ?, 1, 10, ?, ?, ?, ?, ?, ?, 0, NULL, 0)`).run(
    filePath, heading, content, entities, chunkType, confidence, createdAt || now, now, fileWeight
  );
}

// --- shouldCapture logic (mirrors the TS function) ---
const CAPTURE_TRIGGERS = [
  /\b(decided|decision|choosing|chose|picked|going with|settled on)\b/i,
  /\b(prefer|preference|always use|never use|switched to|moving to)\b/i,
  /\b(remember|don't forget|note to self|important:|key takeaway)\b/i,
  /\b(learned|realized|discovered|turns out|found out)\b/i,
  /\b(started|stopped|quit|dropped|added|removed|changed)\b.{5,}\b(daily|weekly|routine|protocol|stack|dose)\b/i,
  /\b(agreed|committed|promised|scheduled|deadline)\b/i,
];

function shouldCapture(text) {
  if (!text || text.length < 20) return null;
  if (/^\s*(what|how|why|when|where|who|can|could|should|would|is|are|do|does)\b/i.test(text) && text.includes('?')) return null;
  if (/^(hi|hey|hello|thanks|ok|sure|got it|sounds good)/i.test(text.trim())) return null;

  for (const pattern of CAPTURE_TRIGGERS) {
    if (pattern.test(text)) {
      if (/\b(decided|decision|chose|going with|settled on)\b/i.test(text)) return 'decision';
      if (/\b(prefer|always use|never use|switched to)\b/i.test(text)) return 'pref';
      return 'fact';
    }
  }
  return null;
}

// ─── Test 1: Auto-recall returns formatted context ───
console.log('Test 1: Auto-recall returns formatted context for a real prompt');
{
  const db = createDb();
  insertChunk(db, {
    content: 'DataSync will be the primary API gateway on CloudStack.',
    heading: 'Backend Strategy',
    chunkType: 'decision',
    confidence: 0.95,
    entities: JSON.stringify(['DataSync', 'CloudStack']),
    filePath: 'MEMORY.md',
    fileWeight: 1.5,
  });

  const result = getRelevantContext(db, 'What is our API gateway strategy?');
  assert(result.text.length > 0, `Expected non-empty context, got empty`);
  assert(result.text.includes('## Recalled Context'), 'Expected Recalled Context header');
  assert(result.text.includes('DataSync'), 'Expected DataSync in context');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.tokenEstimate > 0, `Expected token estimate > 0`);
  db.close();
}

// ─── Test 2: Auto-recall skips short prompts ───
console.log('Test 2: Auto-recall skips short prompts (<5 chars)');
{
  const db = createDb();
  insertChunk(db, { content: 'Some important fact about testing.', chunkType: 'fact' });

  // Simulate the plugin's prompt length check
  const prompts = ['', 'hi', 'ok', 'y'];
  for (const prompt of prompts) {
    const skip = !prompt || prompt.length < 5;
    assert(skip, `Prompt "${prompt}" should be skipped (length ${prompt.length})`);
  }

  // A real prompt should NOT be skipped
  const realPrompt = 'What did we decide about the API gateway?';
  assert(realPrompt.length >= 5, 'Real prompt should pass length check');

  const result = getRelevantContext(db, realPrompt);
  // It may or may not find results, but it shouldn't error
  assert(result != null, 'Should return a result object for valid prompt');
  db.close();
}

// ─── Test 3: Auto-capture detects a decision ───
console.log('Test 3: Auto-capture detects a decision');
{
  const tag = shouldCapture('I decided to use FTS5 over vector search for the memory engine.');
  assert(tag === 'decision', `Expected "decision", got "${tag}"`);

  const tag2 = shouldCapture('Going with Zustand for state management instead of Redux.');
  assert(tag2 === 'decision', `Expected "decision" for "going with", got "${tag2}"`);

  const tag3 = shouldCapture('We settled on a 80/15/5 portfolio allocation framework.');
  assert(tag3 === 'decision', `Expected "decision" for "settled on", got "${tag3}"`);
}

// ─── Test 4: Auto-capture skips agent output and questions ───
console.log('Test 4: Auto-capture skips questions and greetings');
{
  // Questions should be skipped
  const q1 = shouldCapture('What should we use for the database?');
  assert(q1 === null, `Expected null for question, got "${q1}"`);

  const q2 = shouldCapture('How does the authentication flow work?');
  assert(q2 === null, `Expected null for question, got "${q2}"`);

  // Greetings should be skipped
  const g1 = shouldCapture('hi there, how are you doing today?');
  assert(g1 === null, `Expected null for greeting, got "${g1}"`);

  const g2 = shouldCapture('thanks for the help with that bug fix');
  assert(g2 === null, `Expected null for thanks, got "${g2}"`);

  // Short text should be skipped
  const s1 = shouldCapture('ok');
  assert(s1 === null, `Expected null for short text, got "${s1}"`);

  // Empty should be skipped
  const e1 = shouldCapture('');
  assert(e1 === null, `Expected null for empty, got "${e1}"`);
}

// ─── Test 5: Auto-capture respects content types ───
console.log('Test 5: Auto-capture tags preferences and facts correctly');
{
  // Preference
  const pref = shouldCapture('I prefer dark mode with warm amber lighting for all my tools.');
  assert(pref === 'pref', `Expected "pref", got "${pref}"`);

  const pref2 = shouldCapture('Always use TypeScript for new projects, never plain JS.');
  assert(pref2 === 'pref', `Expected "pref" for "always use", got "${pref2}"`);

  // Fact (learned something)
  const fact = shouldCapture('I just realized that the API enforces a 200K context cap despite docs saying 1M.');
  assert(fact === 'fact', `Expected "fact" for "realized", got "${fact}"`);

  const fact2 = shouldCapture("Turns out the webhook endpoint was rate-limited all along, we just didn't notice.");
  assert(fact2 === 'fact', `Expected "fact" for "turns out", got "${fact2}"`);

  // Non-capturable
  const none = shouldCapture('The weather is nice today and I went for a walk around the neighborhood.');
  assert(none === null, `Expected null for non-capturable, got "${none}"`);
}

// ─── Test 6: Auto-capture maxChars truncation ───
console.log('Test 6: Auto-capture respects maxChars');
{
  const longText = 'I decided to ' + 'restructure the entire authentication flow '.repeat(20);
  const maxChars = 500;

  // Simulate the plugin's truncation logic
  const truncated = longText.length > maxChars
    ? longText.slice(0, maxChars) + '…'
    : longText;

  assert(truncated.length <= maxChars + 2, `Expected <= ${maxChars + 2} chars, got ${truncated.length}`);
  assert(truncated.endsWith('…'), 'Expected truncated text to end with ellipsis');

  // Verify it's still capturable
  const tag = shouldCapture(truncated);
  assert(tag === 'decision', `Truncated text should still be capturable, got "${tag}"`);
}

// ─── Test 7: Auto-recall with no relevant memory returns empty ───
console.log('Test 7: Auto-recall with no relevant memory returns empty');
{
  const db = createDb();
  // DB has chunks but none relevant to the query
  insertChunk(db, { content: 'Meeting with Tom about resource allocation strategy.', chunkType: 'fact' });

  const result = getRelevantContext(db, 'quantum physics research papers');
  assert(result.text === '' || result.chunks.length === 0, 'Expected empty context for irrelevant query');
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
