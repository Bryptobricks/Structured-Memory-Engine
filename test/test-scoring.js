#!/usr/bin/env node
/**
 * Unit tests for shared scoring module (lib/scoring.js) and CIL utility functions.
 * Tests: score(), normalizeFtsScores(), weight profiles, cilScore(), budgetChunks(),
 * extractQueryTerms(), entity cache, and CIL skipTracking behavior.
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { score, normalizeFtsScores, RECALL_PROFILE, CIL_PROFILE, CIL_SEMANTIC_PROFILE, TYPE_BONUS } = require('../lib/scoring');
const { cilScore, budgetChunks, extractQueryTerms, invalidateEntityCache, getRelevantContext } = require('../lib/context');

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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const nowMs = Date.now();

// ─── Test 1: score() — higher confidence = higher score ───
console.log('Test 1: score() — confidence multiplier');
{
  const base = { confidence: 1.0, created_at: new Date().toISOString(), chunk_type: 'fact', file_weight: 1.0, _normalizedFts: 0.8 };
  const low = { ...base, confidence: 0.3 };

  const scoreHigh = score(base, nowMs, CIL_PROFILE);
  const scoreLow = score(low, nowMs, CIL_PROFILE);
  assert(scoreHigh > scoreLow, `Confidence 1.0 (${scoreHigh.toFixed(3)}) should beat 0.3 (${scoreLow.toFixed(3)})`);

  // CIL uses pow(1.5) — verify the gap is larger than linear
  const ratio = scoreLow / scoreHigh;
  assert(ratio < 0.3, `pow(1.5) should make low-conf drop sharper than linear, ratio: ${ratio.toFixed(3)}`);
}

// ─── Test 2: score() — recency matters ───
console.log('Test 2: score() — recency decay');
{
  const fresh = { confidence: 1.0, created_at: new Date().toISOString(), chunk_type: 'raw', file_weight: 1.0, _normalizedFts: 0.8 };
  const old = { ...fresh, created_at: daysAgo(120) };

  const scoreFresh = score(fresh, nowMs, CIL_PROFILE);
  const scoreOld = score(old, nowMs, CIL_PROFILE);
  assert(scoreFresh > scoreOld, `Fresh (${scoreFresh.toFixed(3)}) should beat old (${scoreOld.toFixed(3)})`);
}

// ─── Test 3: score() — type bonus ordering ───
console.log('Test 3: score() — type bonus ordering');
{
  const base = { confidence: 1.0, created_at: daysAgo(30), file_weight: 1.0, _normalizedFts: 0.5 };

  const confirmed = score({ ...base, chunk_type: 'confirmed' }, nowMs, CIL_PROFILE);
  const inferred = score({ ...base, chunk_type: 'inferred' }, nowMs, CIL_PROFILE);
  const outdated = score({ ...base, chunk_type: 'outdated' }, nowMs, CIL_PROFILE);

  assert(confirmed > inferred, `confirmed (${confirmed.toFixed(3)}) should beat inferred (${inferred.toFixed(3)})`);
  assert(inferred > outdated, `inferred (${inferred.toFixed(3)}) should beat outdated (${outdated.toFixed(3)})`);
}

// ─── Test 4: score() — file weight boost ───
console.log('Test 4: score() — file weight boost');
{
  const base = { confidence: 1.0, created_at: daysAgo(10), chunk_type: 'raw', _normalizedFts: 0.5 };
  const heavy = { ...base, file_weight: 1.5 };
  const normal = { ...base, file_weight: 1.0 };

  const scoreHeavy = score(heavy, nowMs, CIL_PROFILE);
  const scoreNormal = score(normal, nowMs, CIL_PROFILE);
  assert(scoreHeavy > scoreNormal, `Heavy (${scoreHeavy.toFixed(3)}) should beat normal (${scoreNormal.toFixed(3)})`);
}

// ─── Test 5: score() — entity match bonus ───
console.log('Test 5: score() — entity match bonus');
{
  const base = { confidence: 1.0, created_at: daysAgo(5), chunk_type: 'fact', file_weight: 1.0, _normalizedFts: 0.5 };
  const withEntity = { ...base, _entityMatch: true };
  const without = { ...base, _entityMatch: false };

  const scoreWith = score(withEntity, nowMs, CIL_PROFILE);
  const scoreWithout = score(without, nowMs, CIL_PROFILE);
  assert(scoreWith > scoreWithout, `Entity match (${scoreWith.toFixed(3)}) should beat no match (${scoreWithout.toFixed(3)})`);
}

// ─── Test 6: score() — semantic boost (CIL_SEMANTIC_PROFILE) ───
console.log('Test 6: score() — semantic boost');
{
  const base = { confidence: 1.0, created_at: daysAgo(5), chunk_type: 'fact', file_weight: 1.0, _normalizedFts: 0.5 };
  const highSem = { ...base, _semanticSim: 0.95 };
  const lowSem = { ...base, _semanticSim: 0.1 };

  const scoreHigh = score(highSem, nowMs, CIL_SEMANTIC_PROFILE);
  const scoreLow = score(lowSem, nowMs, CIL_SEMANTIC_PROFILE);
  assert(scoreHigh > scoreLow, `High semantic (${scoreHigh.toFixed(3)}) should beat low (${scoreLow.toFixed(3)})`);
}

// ─── Test 7: RECALL_PROFILE uses linear confidence (exponent 1.0) ───
console.log('Test 7: RECALL_PROFILE uses linear confidence');
{
  const base = { confidence: 0.6, created_at: daysAgo(5), chunk_type: 'fact', file_weight: 1.0, _normalizedFts: 0.8 };
  const full = { ...base, confidence: 1.0 };

  const s06 = score(base, nowMs, RECALL_PROFILE);
  const s10 = score(full, nowMs, RECALL_PROFILE);
  const ratio = s06 / s10;
  // With linear confidence: ratio should be ~0.6
  assert(ratio > 0.55 && ratio < 0.65, `RECALL linear confidence ratio should be ~0.6, got ${ratio.toFixed(3)}`);

  // Compare with CIL which uses pow(1.5): ratio should be ~0.465
  const c06 = score(base, nowMs, CIL_PROFILE);
  const c10 = score(full, nowMs, CIL_PROFILE);
  const cilRatio = c06 / c10;
  assert(cilRatio < ratio, `CIL pow(1.5) ratio (${cilRatio.toFixed(3)}) should be lower than RECALL linear (${ratio.toFixed(3)})`);
}

// ─── Test 8: normalizeFtsScores ───
console.log('Test 8: normalizeFtsScores');
{
  // Empty array — no crash
  normalizeFtsScores([]);

  // Single result — normalized to 1.0
  const single = [{ rank: -5.0 }];
  normalizeFtsScores(single);
  assert(single[0]._normalizedFts === 1.0, `Single result should be 1.0, got ${single[0]._normalizedFts}`);

  // Multiple results — worst rank gets 0.3 floor, best gets 1.0
  const multi = [{ rank: -10 }, { rank: -5 }, { rank: -1 }];
  normalizeFtsScores(multi);
  assert(multi[0]._normalizedFts === 1.0, `Best rank (most negative) should be 1.0, got ${multi[0]._normalizedFts}`);
  assert(Math.abs(multi[2]._normalizedFts - 0.3) < 0.001, `Worst rank should be 0.3, got ${multi[2]._normalizedFts}`);

  // Equal ranks — all get 0.3 floor (range is 0, delta is 0)
  const equal = [{ rank: -5 }, { rank: -5 }];
  normalizeFtsScores(equal);
  assert(Math.abs(equal[0]._normalizedFts - 0.3) < 0.001, `Equal ranks should be 0.3 (floor), got ${equal[0]._normalizedFts}`);
  assert(Math.abs(equal[1]._normalizedFts - 0.3) < 0.001, `Both should be 0.3 (floor), got ${equal[1]._normalizedFts}`);
}

// ─── Test 9: extractQueryTerms ───
console.log('Test 9: extractQueryTerms');
{
  // Basic extraction — stopwords removed, 2+ char filter
  const terms = extractQueryTerms('what is the creatine dosing protocol?');
  assert(terms.includes('creatine'), 'Should include creatine');
  assert(terms.includes('dosing'), 'Should include dosing');
  assert(terms.includes('protocol'), 'Should include protocol');
  assert(!terms.includes('is'), 'Should not include stopword "is"');
  assert(!terms.includes('the'), 'Should not include stopword "the"');

  // Proper noun extraction
  const withProper = extractQueryTerms('Send Tom the TechConf details');
  assert(withProper.includes('tom'), 'Should include proper noun Tom (lowercased)');
  assert(withProper.includes('techconf'), 'Should include proper noun TechConf (lowercased)');

  // Empty input
  const empty = extractQueryTerms('');
  assert(empty.length === 0, `Empty input should return empty array, got ${empty.length}`);

  // Short words excluded
  const short = extractQueryTerms('I am OK');
  assert(!short.includes('am'), 'Short words (<= 2 chars) should be excluded');
}

// ─── Test 10: budgetChunks ───
console.log('Test 10: budgetChunks');
{
  const chunks = [
    { content: 'A'.repeat(100), chunkType: 'fact', confidence: 1.0, filePath: 'a.md', lineStart: 1 },
    { content: 'B'.repeat(100), chunkType: 'fact', confidence: 1.0, filePath: 'b.md', lineStart: 1 },
    { content: 'C'.repeat(100), chunkType: 'fact', confidence: 1.0, filePath: 'c.md', lineStart: 1 },
    { content: 'D'.repeat(100), chunkType: 'fact', confidence: 1.0, filePath: 'd.md', lineStart: 1 },
    { content: 'E'.repeat(100), chunkType: 'fact', confidence: 1.0, filePath: 'e.md', lineStart: 1 },
  ];

  // Tight budget — should return fewer chunks
  const tight = budgetChunks(chunks, 100);
  assert(tight.length < chunks.length, `Tight budget should reduce chunks, got ${tight.length} of ${chunks.length}`);

  // Generous budget — should return all
  const generous = budgetChunks(chunks, 5000);
  assert(generous.length === chunks.length, `Generous budget should keep all, got ${generous.length}`);

  // Empty input
  const empty = budgetChunks([], 1000);
  assert(empty.length === 0, `Empty input should return empty, got ${empty.length}`);

  // Last chunk truncated when budget allows partial but not full
  // budget = maxTokens - HEADER_OVERHEAD(30) = 170. Chunk = ceil(500/3.5)+25 = 168.
  // 168 > 170 is false... let's use a bigger chunk.
  // budget = 200 - 30 = 170. Chunk with 1000 chars = ceil(1000/3.5)+25 = 311. 311 > 170.
  // budget > 100 ✓, availableForContent = 170 - 25 = 145 > 50 ✓ → truncates.
  const bigChunks = [
    { content: 'X'.repeat(1000), chunkType: 'fact', confidence: 1.0, filePath: 'x.md', lineStart: 1 },
  ];
  const truncated = budgetChunks(bigChunks, 200);
  assert(truncated.length === 1, `Should include truncated chunk, got ${truncated.length}`);
  assert(truncated[0].truncated === true, 'Chunk should be marked truncated');
  assert(truncated[0].content.endsWith('…'), 'Truncated content should end with ellipsis');
}

// ─── Test 11: cilScore delegates to shared scorer ───
console.log('Test 11: cilScore delegates to shared scorer');
{
  const chunk = { confidence: 1.0, created_at: daysAgo(5), chunk_type: 'confirmed', file_weight: 1.5, _normalizedFts: 0.9, _entityMatch: true };

  const fromCil = cilScore(chunk, nowMs, { recencyBoostDays: 30 });
  const fromShared = score(chunk, nowMs, CIL_PROFILE, { recencyHalfLifeDays: 30 });
  assert(Math.abs(fromCil - fromShared) < 0.001, `cilScore (${fromCil.toFixed(4)}) should match shared score (${fromShared.toFixed(4)})`);
}

// ─── Test 12: CIL pipeline does not inflate access_count ───
console.log('Test 12: CIL pipeline does not inflate access_count (skipTracking)');
{
  const db = createDb();
  insertChunk(db, {
    content: 'Creatine 5g daily started Feb 23.',
    heading: 'Creatine Tracking',
    entities: JSON.stringify(['creatine']),
    chunkType: 'fact',
    confidence: 1.0,
    createdAt: daysAgo(4),
    filePath: 'MEMORY.md',
    fileWeight: 1.5,
  });

  // Run CIL pipeline
  const result = getRelevantContext(db, "How's the creatine experiment going?");
  assert(result.chunks.length > 0, `CIL should find chunks, got ${result.chunks.length}`);

  // Access count should still be 0 — CIL uses skipTracking
  const row = db.prepare('SELECT access_count FROM chunks').get();
  assert(row.access_count === 0, `CIL should not inflate access_count, got ${row.access_count}`);
  db.close();
}

// ─── Test 13: Entity cache invalidation ───
console.log('Test 13: Entity cache invalidation');
{
  // This test verifies invalidateEntityCache resets the cache.
  // We can't directly observe the cache, but we can ensure it doesn't crash
  // and that subsequent calls rebuild it.
  invalidateEntityCache();

  const db = createDb();
  insertChunk(db, {
    content: 'Tom sent the project roadmap',
    entities: JSON.stringify(['Tom']),
    chunkType: 'fact',
  });

  // First call should build entity cache from scratch
  const result1 = getRelevantContext(db, 'What did Tom send?');
  assert(result1.chunks.length > 0, 'Should find chunks after cache invalidation');

  // Second call should use cached entities
  const result2 = getRelevantContext(db, 'What did Tom send?');
  assert(result2.chunks.length > 0, 'Should find chunks from cached entities');

  // Invalidate again
  invalidateEntityCache();

  // Add new entity
  insertChunk(db, {
    content: 'Nexus API health monitoring needs alerts',
    entities: JSON.stringify(['Nexus']),
    chunkType: 'decision',
  });

  // After invalidation, new entity should be picked up
  const result3 = getRelevantContext(db, 'What about Nexus?');
  assert(result3.chunks.length > 0, 'Should find new entity after cache invalidation');

  db.close();
}

// ─── Test 14: Weight profile constants are valid ───
console.log('Test 14: Weight profile constants are valid');
{
  for (const [name, profile] of [['RECALL', RECALL_PROFILE], ['CIL', CIL_PROFILE], ['CIL_SEMANTIC', CIL_SEMANTIC_PROFILE]]) {
    const sum = profile.fts + profile.recency + profile.type + profile.fileWeight + profile.entity + profile.semantic;
    assert(Math.abs(sum - 1.0) < 0.001, `${name} weights should sum to 1.0, got ${sum}`);
    assert(profile.confidenceExponent > 0, `${name} confidence exponent should be > 0`);
    assert(profile.recencyHalfLifeDays > 0, `${name} recency half-life should be > 0`);
  }
}

// ─── Test 15: score() handles missing/null fields gracefully ───
console.log('Test 15: score() handles missing/null fields');
{
  const minimal = {}; // no fields set
  const s = score(minimal, nowMs, CIL_PROFILE);
  assert(typeof s === 'number', `Should return a number, got ${typeof s}`);
  assert(!isNaN(s), 'Should not be NaN');
  assert(s >= 0, `Score should be >= 0, got ${s}`);
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
