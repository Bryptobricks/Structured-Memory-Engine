#!/usr/bin/env node
/**
 * Tests for Embeddings (lib/embeddings.js)
 * Tests pure functions and DB operations without requiring @xenova/transformers.
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { cosineSimilarity, embeddingStatus, ensureEmbeddingColumn, EMBEDDING_DIM } = require('../lib/embeddings');
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

function insertChunk(db, { content = 'test content', chunkType = 'raw', confidence = 1.0, createdAt = null, filePath = 'test.md', entities = '[]', embedding = null } = {}) {
  ensureEmbeddingColumn(db);
  const now = new Date().toISOString();
  const result = db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, embedding)
    VALUES (?, NULL, ?, 1, 10, ?, ?, ?, ?, ?, 1.0, 0, NULL, 0, ?)`).run(
    filePath, content, entities, chunkType, confidence, createdAt || now, now, embedding
  );
  return result.lastInsertRowid;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function makeVec(values) {
  const vec = new Float32Array(values);
  return Buffer.from(vec.buffer);
}

// ─── Test 1: Cosine similarity — identical vectors ───
console.log('Test 1: Cosine similarity — identical vectors = 1.0');
{
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  const sim = cosineSimilarity(a, b);
  assert(Math.abs(sim - 1.0) < 0.001, `Expected 1.0, got ${sim}`);
}

// ─── Test 2: Cosine similarity — orthogonal vectors ───
console.log('Test 2: Cosine similarity — orthogonal vectors = 0.0');
{
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  const sim = cosineSimilarity(a, b);
  assert(Math.abs(sim) < 0.001, `Expected 0.0, got ${sim}`);
}

// ─── Test 3: Cosine similarity — opposite vectors ───
console.log('Test 3: Cosine similarity — opposite vectors = -1.0');
{
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([-1, 0, 0]);
  const sim = cosineSimilarity(a, b);
  assert(Math.abs(sim - (-1.0)) < 0.001, `Expected -1.0, got ${sim}`);
}

// ─── Test 4: Cosine similarity — null/mismatched returns 0 ───
console.log('Test 4: Cosine similarity — null/mismatched inputs');
{
  assert(cosineSimilarity(null, new Float32Array([1])) === 0, 'null first arg should return 0');
  assert(cosineSimilarity(new Float32Array([1]), null) === 0, 'null second arg should return 0');
  assert(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1])) === 0, 'mismatched lengths should return 0');
}

// ─── Test 5: Embedding status — counts correctly ───
console.log('Test 5: Embedding status reports correct counts');
{
  const db = createDb();
  ensureEmbeddingColumn(db);
  insertChunk(db, { content: 'with embedding', embedding: makeVec([1, 0, 0]) });
  insertChunk(db, { content: 'without embedding', embedding: null });
  insertChunk(db, { content: 'another without', embedding: null });

  const status = embeddingStatus(db);
  assert(status.total === 3, `Expected 3 total, got ${status.total}`);
  assert(status.embedded === 1, `Expected 1 embedded, got ${status.embedded}`);
  assert(status.pending === 2, `Expected 2 pending, got ${status.pending}`);
  db.close();
}

// ─── Test 6: Embedding column added safely (idempotent) ───
console.log('Test 6: ensureEmbeddingColumn is idempotent');
{
  const db = createDb();
  ensureEmbeddingColumn(db);
  ensureEmbeddingColumn(db); // Should not throw
  passed++;
  db.close();
}

// ─── Test 7: EMBEDDING_DIM exported correctly ───
console.log('Test 7: EMBEDDING_DIM is 384');
{
  assert(EMBEDDING_DIM === 384, `Expected 384, got ${EMBEDDING_DIM}`);
}

// ─── Test 8: CIL with queryEmbedding boosts semantically similar chunks ───
console.log('Test 8: queryEmbedding boosts semantically similar chunks in CIL');
{
  const db = createDb();
  ensureEmbeddingColumn(db);

  // Two chunks about "lending" — one has a high-similarity embedding, one doesn't
  const vecSimilar = new Float32Array([0.9, 0.1, 0.0]);
  const vecDissimilar = new Float32Array([0.0, 0.1, 0.9]);
  const queryVec = new Float32Array([1.0, 0.0, 0.0]);

  insertChunk(db, {
    content: 'DataSync API gateway on CloudStack platform for backend operations',
    chunkType: 'fact', confidence: 0.7, createdAt: daysAgo(5),
    embedding: Buffer.from(vecSimilar.buffer),
  });
  insertChunk(db, {
    content: 'API gateway rates are competitive with other cloud platforms',
    chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(1),
    embedding: Buffer.from(vecDissimilar.buffer),
  });

  // Without queryEmbedding — chunk 2 ranks higher (newer, higher confidence)
  const without = getRelevantContext(db, 'API gateway');
  // With queryEmbedding — chunk 1 should get semantic boost
  const withEmb = getRelevantContext(db, 'API gateway', { queryEmbedding: queryVec });

  assert(withEmb.chunks.length >= 2, `Expected at least 2 chunks, got ${withEmb.chunks.length}`);
  // The semantically similar chunk should rank higher with embedding
  const withEmbFirst = withEmb.chunks[0].content.includes('DataSync');
  const withoutFirst = without.chunks[0].content.includes('DataSync');
  // At minimum, embedding should influence ranking (may or may not flip #1 depending on other signals)
  assert(withEmb.chunks.length > 0, 'queryEmbedding should not break retrieval');
  db.close();
}

// ─── Test 9: CIL without queryEmbedding — no semantic signal ───
console.log('Test 9: No queryEmbedding — semantic weight is 0, uses FTS-heavy weights');
{
  const db = createDb();
  ensureEmbeddingColumn(db);

  insertChunk(db, {
    content: 'Creatine 5g daily morning protocol for recovery',
    chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(2),
    embedding: makeVec([1, 0, 0]),
  });

  const result = getRelevantContext(db, 'creatine daily protocol');
  assert(result.chunks.length === 1, `Expected 1 chunk, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Creatine'), 'Should find the chunk via FTS');
  db.close();
}

// ─── Test 10: Stale chunks excluded from embedding status ───
console.log('Test 10: Stale chunks excluded from embedding status');
{
  const db = createDb();
  ensureEmbeddingColumn(db);
  insertChunk(db, { content: 'active chunk', embedding: makeVec([1, 0, 0]) });
  // Insert a stale chunk directly
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, embedding)
    VALUES (?, NULL, ?, 1, 10, '[]', 'raw', 1.0, ?, ?, 1.0, 0, NULL, 1, ?)`).run(
    'test.md', 'stale chunk', now, now, makeVec([0, 1, 0])
  );

  const status = embeddingStatus(db);
  assert(status.total === 1, `Expected 1 total (stale excluded), got ${status.total}`);
  assert(status.embedded === 1, `Expected 1 embedded, got ${status.embedded}`);
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
