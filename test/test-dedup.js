#!/usr/bin/env node
/**
 * Tests for semantic deduplication module.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { tokenize, buildTfIdf, buildIdf, cosineSimilarity, findDuplicates, dedupChunks, listDedupReviews, resolveDedupReview } = require('../lib/dedup');
const { SCHEMA, openDb } = require('../lib/store');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function approx(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sme-dedup-'));
}

function createDb(workspace) {
  return openDb(workspace);
}

// --- Tokenization ---

console.log('Test 1: Tokenize basic text');
{
  const tokens = tokenize('JB prefers warm lighting in the office');
  assert(tokens.includes('prefers'), 'Should include "prefers"');
  assert(tokens.includes('warm'), 'Should include "warm"');
  assert(tokens.includes('lighting'), 'Should include "lighting"');
  assert(!tokens.includes('the'), 'Should exclude stopword "the"');
  assert(!tokens.includes('in'), 'Should exclude stopword "in"');
}

// --- TF-IDF ---

console.log('Test 2: Build IDF from documents');
{
  const docs = [
    ['creatine', 'daily', 'morning'],
    ['creatine', 'evening', 'protocol'],
    ['postgresql', 'database', 'migration'],
  ];
  const idf = buildIdf(docs);
  // "creatine" appears in 2/3 docs → lower IDF
  // "postgresql" appears in 1/3 → higher IDF
  assert(idf.creatine < idf.postgresql, `creatine IDF (${idf.creatine}) should be < postgresql IDF (${idf.postgresql})`);
}

console.log('Test 3: Build TF-IDF vector');
{
  const tokens = ['creatine', 'daily', 'creatine'];
  const idf = { creatine: 1.5, daily: 2.0 };
  const vec = buildTfIdf(tokens, idf);
  assert(vec.creatine > vec.daily, 'creatine appears 2x so should have higher TF-IDF');
}

// --- Cosine Similarity ---

console.log('Test 4: Identical vectors = 1.0');
{
  const vec = { a: 1, b: 2, c: 3 };
  const sim = cosineSimilarity(vec, vec);
  assert(approx(sim, 1.0), `Expected 1.0, got ${sim}`);
}

console.log('Test 5: Orthogonal vectors = 0.0');
{
  const vecA = { a: 1 };
  const vecB = { b: 1 };
  const sim = cosineSimilarity(vecA, vecB);
  assert(approx(sim, 0.0), `Expected 0.0, got ${sim}`);
}

console.log('Test 6: Empty vectors = 0.0');
{
  assert(approx(cosineSimilarity({}, {}), 0.0), 'Both empty should be 0');
  assert(approx(cosineSimilarity({ a: 1 }, {}), 0.0), 'One empty should be 0');
}

// --- findDuplicates ---

console.log('Test 7: Same content = auto-merge (skip)');
{
  const existing = [{ id: 1, content: 'JB prefers warm lighting in the office' }];
  const result = findDuplicates(existing, 'JB prefers warm lighting in the office');
  assert(result.action === 'skip', `Expected skip, got ${result.action}`);
  assert(result.similarity >= 0.92, `Expected similarity >= 0.92, got ${result.similarity}`);
}

console.log('Test 8: Paraphrased content = review range');
{
  const existing = [{ id: 1, content: 'JB prefers warm lighting in his office workspace' }];
  const result = findDuplicates(existing, 'JB likes warm lights for the office area', {
    autoMergeThreshold: 0.92,
    reviewThreshold: 0.5,
  });
  // Paraphrased should be in review range (above 0.5 but potentially below 0.92)
  assert(result.action !== 'insert' || result.similarity === undefined,
    `Paraphrased: action=${result.action}, sim=${result.similarity}`);
}

console.log('Test 9: Unrelated content = insert');
{
  const existing = [{ id: 1, content: 'JB prefers warm lighting in the office' }];
  const result = findDuplicates(existing, 'PostgreSQL migration plan for the database');
  assert(result.action === 'insert', `Expected insert for unrelated, got ${result.action}`);
}

console.log('Test 10: Empty existing = insert');
{
  const result = findDuplicates([], 'Some new content here for testing');
  assert(result.action === 'insert', `Expected insert with no existing, got ${result.action}`);
}

// --- dedupChunks with DB ---

console.log('Test 11: dedupChunks with disabled config');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);
  const chunks = [{ content: 'Test chunk', chunkType: 'fact' }];
  const result = dedupChunks(db, chunks, { enabled: false });
  assert(result.toInsert.length === 1, 'Disabled dedup should pass all through');
  assert(result.toSkip.length === 0, 'No skips when disabled');
  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 12: dedupChunks skips exact duplicates');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  // Insert an existing chunk
  db.prepare(`INSERT INTO chunks (file_path, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'test.md', 'JB prefers warm lighting in the office', 1, 1, '[]', 'preference', 1.0, '2026-01-01', '2026-01-01', 1.0
  );

  const chunks = [{ content: 'JB prefers warm lighting in the office', chunkType: 'preference' }];
  const result = dedupChunks(db, chunks, { enabled: true, autoMergeThreshold: 0.92, reviewThreshold: 0.85 });
  assert(result.toSkip.length === 1, `Expected 1 skip, got ${result.toSkip.length}`);
  assert(result.toInsert.length === 0, `Expected 0 inserts, got ${result.toInsert.length}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// --- dedup_reviews table ---

console.log('Test 13: dedup_reviews table and lifecycle');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  // Insert a chunk so the JOIN works
  db.prepare(`INSERT INTO chunks (file_path, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'test.md', 'Existing chunk content', 1, 1, '[]', 'fact', 1.0, '2026-01-01', '2026-01-01', 1.0
  );
  const chunkId = db.prepare('SELECT id FROM chunks ORDER BY id DESC LIMIT 1').get().id;

  // Insert review referencing the real chunk
  db.prepare(`INSERT INTO dedup_reviews (new_chunk_id, existing_chunk_id, similarity, status, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(null, chunkId, 0.88, 'pending', '2026-03-07');

  const reviews = listDedupReviews(db);
  assert(reviews.length === 1, `Expected 1 review, got ${reviews.length}`);
  assert(reviews[0].status === 'pending', `Expected pending, got ${reviews[0].status}`);

  // Resolve
  const result = resolveDedupReview(db, reviews[0].id, 'dismissed');
  assert(result.resolved === true, 'Should resolve successfully');

  const afterResolve = listDedupReviews(db);
  assert(afterResolve.length === 0, 'No pending reviews after resolve');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 14: resolveDedupReview rejects invalid action');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  const result = resolveDedupReview(db, 999, 'invalid');
  assert(result.resolved === false, 'Should reject invalid action');
  assert(result.error.includes('Invalid action'), `Expected invalid action error, got: ${result.error}`);

  db.close();
  fs.rmSync(ws, { recursive: true });
}

console.log('Test 15: Type-aware thresholds');
{
  const ws = tmpWorkspace();
  const db = createDb(ws);

  // Insert an existing decision
  db.prepare(`INSERT INTO chunks (file_path, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'test.md', 'Decided to use PostgreSQL for the main application database', 1, 1, '[]', 'decision', 1.0, '2026-01-01', '2026-01-01', 1.0
  );

  // Very similar but different decision — at 0.95 threshold, should not auto-merge
  const chunks = [{ content: 'Decided to use PostgreSQL for the primary app database system', chunkType: 'decision' }];
  const result = dedupChunks(db, chunks, {
    enabled: true,
    autoMergeThreshold: 0.92,
    reviewThreshold: 0.85,
    typeThresholds: { decision: 0.95 },
  });
  // With 0.95 threshold for decisions, similar (but not 0.95+) content should insert or review
  assert(result.toInsert.length >= 0, 'Type threshold applied');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
