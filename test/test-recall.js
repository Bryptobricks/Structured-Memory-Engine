#!/usr/bin/env node
/**
 * Tests for recall.js — sanitization, alias expansion, date parsing, ranking, integration.
 */
const Database = require('better-sqlite3');
const { SCHEMA, insertChunks } = require('../lib/store');
const { sanitizeFtsQuery, buildOrQuery, parseSince, rankResults, recall } = require('../lib/recall');

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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── Test 1: sanitizeFtsQuery ───
console.log('Test 1: sanitizeFtsQuery');
{
  assert(sanitizeFtsQuery(null) === null, 'null input → null');
  assert(sanitizeFtsQuery('') === null, 'empty string → null');
  assert(sanitizeFtsQuery('   ') === null, 'whitespace → null');

  const stripped = sanitizeFtsQuery('hello AND world NOT bad');
  assert(!stripped.includes('AND'), 'AND operator should be stripped');
  assert(!stripped.includes('NOT'), 'NOT operator should be stripped');
  assert(stripped.includes('"hello"'), 'terms should be quoted');
  assert(stripped.includes('"world"'), 'all terms should be quoted');

  const multi = sanitizeFtsQuery('  foo   bar  ');
  assert(multi === '"foo" "bar"', `Multiple spaces normalized, got: ${multi}`);
}

// ─── Test 2: buildOrQuery + aliases ───
console.log('Test 2: buildOrQuery + aliases');
{
  const aliases = { crypto: ['defi', 'token'], health: ['medical', 'labs'] };

  const expanded = buildOrQuery('crypto', aliases);
  assert(expanded.includes('"crypto"'), 'Original term preserved');
  assert(expanded.includes('"defi"'), 'Alias defi expanded');
  assert(expanded.includes('"token"'), 'Alias token expanded');
  assert(expanded.includes(' OR '), 'Terms joined with OR');

  const multi = buildOrQuery('crypto health', aliases);
  assert(multi.includes('"defi"'), 'First term aliases present');
  assert(multi.includes('"medical"'), 'Second term aliases present');

  // No duplicates when term appears in its own aliases
  const selfAlias = { foo: ['bar', 'foo'] };
  const noDup = buildOrQuery('foo', selfAlias);
  const fooCount = (noDup.match(/"foo"/g) || []).length;
  assert(fooCount === 1, `Should have exactly 1 "foo", got ${fooCount}`);

  // Case-insensitive alias lookup
  const caseResult = buildOrQuery('Crypto', aliases);
  assert(caseResult.includes('"defi"'), 'Case-insensitive alias lookup');

  // No alias → passthrough
  const noAlias = buildOrQuery('xyzzy', aliases);
  assert(noAlias === '"xyzzy"', `No alias passthrough, got: ${noAlias}`);

  assert(buildOrQuery(null, aliases) === null, 'null → null');
  assert(buildOrQuery('', aliases) === null, 'empty → null');
}

// ─── Test 3: parseSince ───
console.log('Test 3: parseSince');
{
  assert(parseSince(null) === null, 'null → null');

  // Absolute date passthrough
  const abs = parseSince('2026-01-15');
  assert(abs === '2026-01-15', `Absolute date passthrough, got: ${abs}`);

  // Relative: 7d
  const sevenD = parseSince('7d');
  assert(sevenD != null, '7d should return a date');
  const sevenDDate = new Date(sevenD);
  const diffDays = Math.round((Date.now() - sevenDDate.getTime()) / (1000 * 60 * 60 * 24));
  assert(diffDays >= 6 && diffDays <= 8, `7d should be ~7 days ago, got ${diffDays}`);

  // Relative: 2w
  const twoW = parseSince('2w');
  assert(twoW != null, '2w should return a date');
  const twoWDiff = Math.round((Date.now() - new Date(twoW).getTime()) / (1000 * 60 * 60 * 24));
  assert(twoWDiff >= 13 && twoWDiff <= 15, `2w should be ~14 days ago, got ${twoWDiff}`);

  // Relative: 3m
  const threeM = parseSince('3m');
  assert(threeM != null, '3m should return a date');

  // Relative: 1y
  const oneY = parseSince('1y');
  assert(oneY != null, '1y should return a date');
  const oneYDiff = Math.round((Date.now() - new Date(oneY).getTime()) / (1000 * 60 * 60 * 24));
  assert(oneYDiff >= 360 && oneYDiff <= 370, `1y should be ~365 days ago, got ${oneYDiff}`);

  // Invalid
  assert(parseSince('banana') === null, 'Invalid → null');
  assert(parseSince('5x') === null, 'Unknown unit → null');
}

// ─── Test 4: rankResults ───
console.log('Test 4: rankResults');
{
  const now = new Date().toISOString();
  const oldDate = daysAgo(120);

  const rows = [
    { rank: -10, file_weight: 1.0, confidence: 1.0, created_at: now, content: 'fresh', heading: 'A', file_path: 'a.md', line_start: 1, line_end: 5, chunk_type: 'fact', entities: '[]' },
    { rank: -10, file_weight: 1.0, confidence: 1.0, created_at: oldDate, content: 'old', heading: 'B', file_path: 'b.md', line_start: 1, line_end: 5, chunk_type: 'raw', entities: '[]' },
  ];

  const ranked = rankResults(rows);
  assert(ranked.length === 2, 'Should return 2 results');
  // Fresh content should rank better (more negative finalScore) due to recency boost
  assert(ranked[0].content === 'fresh', `Fresh should rank first, got: ${ranked[0].content}`);

  // File weight multiplier
  const weightRows = [
    { rank: -10, file_weight: 1.5, confidence: 1.0, created_at: oldDate, content: 'heavy', heading: null, file_path: 'MEMORY.md', line_start: 1, line_end: 5, chunk_type: 'raw', entities: '[]' },
    { rank: -10, file_weight: 1.0, confidence: 1.0, created_at: oldDate, content: 'normal', heading: null, file_path: 'daily.md', line_start: 1, line_end: 5, chunk_type: 'raw', entities: '[]' },
  ];
  const weightRanked = rankResults(weightRows);
  assert(weightRanked[0].content === 'heavy', `Higher file weight should rank first, got: ${weightRanked[0].content}`);

  // Confidence multiplier
  const confRows = [
    { rank: -10, file_weight: 1.0, confidence: 1.0, created_at: oldDate, content: 'confident', heading: null, file_path: 'a.md', line_start: 1, line_end: 5, chunk_type: 'fact', entities: '[]' },
    { rank: -10, file_weight: 1.0, confidence: 0.3, created_at: oldDate, content: 'uncertain', heading: null, file_path: 'b.md', line_start: 1, line_end: 5, chunk_type: 'inferred', entities: '[]' },
  ];
  const confRanked = rankResults(confRows);
  assert(confRanked[0].content === 'confident', `Higher confidence should rank first, got: ${confRanked[0].content}`);
}

// ─── Test 5: recall integration ───
console.log('Test 5: recall integration');
{
  // AND hit returns results
  const db = createDb();
  insertChunks(db, 'test.md', 1000, [
    { heading: 'Protocol', content: 'magnesium glycinate supplement before bed', lineStart: 1, lineEnd: 5, entities: [] },
    { heading: 'Stack', content: 'zinc picolinate morning routine daily', lineStart: 6, lineEnd: 10, entities: [] },
    { heading: 'Old', content: 'outdated magnesium protocol from last year', lineStart: 11, lineEnd: 15, entities: [] },
  ], daysAgo(5));
  // Mark third chunk as stale
  db.prepare('UPDATE chunks SET stale = 1 WHERE line_start = 11').run();

  const hits = recall(db, 'magnesium', { limit: 10 });
  assert(hits.length >= 1, `AND hit should return results, got ${hits.length}`);
  assert(hits[0].content.includes('magnesium'), 'Result should contain search term');

  // Default excludes stale
  const noStale = recall(db, 'magnesium', { limit: 10 });
  const staleHits = noStale.filter(r => r.content.includes('outdated'));
  assert(staleHits.length === 0, 'Default should exclude stale chunks');

  // includeStale shows stale
  const withStale = recall(db, 'magnesium', { limit: 10, includeStale: true });
  const staleFound = withStale.filter(r => r.content.includes('outdated'));
  assert(staleFound.length === 1, `includeStale should find stale chunk, got ${staleFound.length}`);

  // AND miss triggers OR fallback
  const fallback = recall(db, 'zinc supplement', { limit: 10 });
  assert(fallback.length >= 1, `OR fallback should find results, got ${fallback.length}`);

  // Context window attaches adjacent chunks
  const ctxResults = recall(db, 'magnesium', { limit: 10, context: 1 });
  assert(ctxResults.length >= 1, 'Context query should return results');
  // Adjacent chunks should be attached (if file has neighbors)
  if (ctxResults[0].context) {
    assert(Array.isArray(ctxResults[0].context), 'Context should be an array');
  }

  // Bad FTS query doesn't crash
  const badQuery = recall(db, '"""invalid FTS', { limit: 10 });
  assert(Array.isArray(badQuery), 'Bad FTS should return array (not throw)');

  db.close();
}

// ─── Test 6: Stop word filtering in sanitizeFtsQuery ───
console.log('Test 6: Stop word filtering in sanitizeFtsQuery');
{
  // Pure stop words → null
  const pure = sanitizeFtsQuery('where am I at with my');
  assert(pure === null, `Pure stop words should return null, got: ${pure}`);

  // Mixed: stop words stripped, content words kept
  const mixed = sanitizeFtsQuery('where is my bromantane?');
  assert(mixed !== null, 'Mixed query should not be null');
  assert(mixed.includes('"bromantane"'), `Should contain bromantane, got: ${mixed}`);
  assert(!mixed.includes('"where"'), 'Should not contain "where"');
  assert(!mixed.includes('"my"'), 'Should not contain "my"');

  // Punctuation stripped
  const punct = sanitizeFtsQuery("what's JB's portfolio?");
  assert(punct !== null, 'Punctuation query should not be null');
  assert(punct.includes('"JB"'), `Should have JB after possessive strip, got: ${punct}`);
  assert(punct.includes('"portfolio"'), `Should have portfolio, got: ${punct}`);

  // "how is it going" → all stop words → null
  const allStop = sanitizeFtsQuery('how is it going');
  assert(allStop === null, `All stop words should return null, got: ${allStop}`);

  // "how is my ETH doing" → just ETH
  const eth = sanitizeFtsQuery('how is my ETH doing');
  assert(eth !== null, 'ETH query should not be null');
  assert(eth.includes('"ETH"'), `Should contain ETH, got: ${eth}`);
}

// ─── Test 7: Stop word filtering in buildOrQuery ───
console.log('Test 7: Stop word filtering in buildOrQuery');
{
  const aliases = { crypto: ['defi', 'token'] };

  // Pure stop words → null
  const pure = buildOrQuery('how is it going', aliases);
  assert(pure === null, `Pure stop words should return null, got: ${pure}`);

  // Mixed: keeps content, expands aliases
  const mixed = buildOrQuery('where is my crypto', aliases);
  assert(mixed !== null, 'Mixed query should not be null');
  assert(mixed.includes('"crypto"'), 'Should contain crypto');
  assert(mixed.includes('"defi"'), 'Should expand crypto alias');
  assert(!mixed.includes('"where"'), 'Should not contain stop word "where"');
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
