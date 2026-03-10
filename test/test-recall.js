#!/usr/bin/env node
/**
 * Tests for recall.js — sanitization, alias expansion, date parsing, ranking, integration.
 */
const Database = require('better-sqlite3');
const { SCHEMA, insertChunks } = require('../lib/store');
const { sanitizeFtsQuery, buildOrQuery, parseSince, rankResults, recall } = require('../lib/recall');
const { cosineSimilarity, ensureEmbeddingColumn } = require('../lib/embeddings');
const { RECALL_PROFILE, RECALL_SEMANTIC_PROFILE } = require('../lib/scoring');

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
  const punct = sanitizeFtsQuery("what's Alex's portfolio?");
  assert(punct !== null, 'Punctuation query should not be null');
  assert(punct.includes('"Alex"'), `Should have Alex after possessive strip, got: ${punct}`);
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

// ─── Embedding helpers ───
function makeVec(values) {
  const vec = new Float32Array(values);
  return Buffer.from(vec.buffer);
}

function insertChunkWithEmbedding(db, { heading = null, content = 'test content', chunkType = 'raw', confidence = 1.0, createdAt = null, filePath = 'test.md', entities = '[]', fileWeight = 1.0, embedding = null, stale = 0 } = {}) {
  ensureEmbeddingColumn(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, embedding)
    VALUES (?, ?, ?, 1, 10, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`).run(
    filePath, heading, content, entities, chunkType, confidence, createdAt || now, now, fileWeight, stale, embedding
  );
}

// ─── Test 8: recall with queryEmbedding enriches results with semantic scores ───
console.log('Test 8: recall with queryEmbedding enriches results with semantic scores');
{
  const db = createDb();
  const queryVec = new Float32Array([1.0, 0.0, 0.0]);

  insertChunkWithEmbedding(db, {
    content: 'magnesium glycinate supplement protocol',
    heading: 'Supplements',
    embedding: makeVec([0.9, 0.1, 0.0]),
  });
  insertChunkWithEmbedding(db, {
    content: 'magnesium oxide cheap alternative',
    heading: 'Budget',
    embedding: makeVec([0.1, 0.0, 0.9]),
  });

  const results = recall(db, 'magnesium', { limit: 10, queryEmbedding: queryVec });
  assert(results.length >= 1, `Should find results, got ${results.length}`);

  const withSem = results.filter(r => r.semanticSim != null);
  assert(withSem.length >= 1, `At least one result should have semanticSim, got ${withSem.length}`);

  // The chunk closer to queryVec [1,0,0] should have higher semanticSim
  if (results.length >= 2) {
    const supp = results.find(r => r.content.includes('glycinate'));
    const budget = results.find(r => r.content.includes('oxide'));
    if (supp && budget) {
      assert(supp.semanticSim > budget.semanticSim, `Glycinate sim (${supp.semanticSim.toFixed(3)}) should beat oxide (${budget.semanticSim.toFixed(3)})`);
    }
  }
  db.close();
}

// ─── Test 9: recall without queryEmbedding works identically (regression) ───
console.log('Test 9: recall without queryEmbedding — no semantic scores');
{
  const db = createDb();
  insertChunkWithEmbedding(db, {
    content: 'creatine monohydrate 5g daily',
    heading: 'Creatine',
    embedding: makeVec([1, 0, 0]),
  });

  const results = recall(db, 'creatine', { limit: 10 });
  assert(results.length >= 1, `Should find results, got ${results.length}`);
  assert(results[0].semanticSim === null, `Without queryEmbedding, semanticSim should be null, got ${results[0].semanticSim}`);
  db.close();
}

// ─── Test 10: semantic rescue finds chunks FTS missed ───
console.log('Test 10: semantic rescue finds chunks FTS missed ("supplements" → "stack")');
{
  const db = createDb();
  const queryVec = new Float32Array([0.95, 0.05, 0.0]);

  // This chunk has NO keyword overlap with "supplements" — FTS won't find it
  insertChunkWithEmbedding(db, {
    content: 'Current Stack: creatine 5g, zinc picolinate 30mg, vitamin D3 5000IU daily',
    heading: 'Current Stack',
    embedding: makeVec([0.90, 0.10, 0.0]),  // high similarity to query
  });

  // This chunk DOES match "supplements" via FTS
  insertChunkWithEmbedding(db, {
    content: 'Ordered new supplements from Amazon last week',
    heading: 'Shopping',
    embedding: makeVec([0.05, 0.05, 0.90]),  // low similarity
  });

  const results = recall(db, 'supplements', { limit: 10, queryEmbedding: queryVec });
  assert(results.length >= 2, `Should find both FTS and rescued chunks, got ${results.length}`);

  const stackChunk = results.find(r => r.content.includes('Current Stack'));
  assert(stackChunk != null, 'Semantic rescue should surface "Current Stack" chunk');
  if (stackChunk) {
    assert(stackChunk.semanticSim >= 0.30, `Rescued chunk sim (${stackChunk.semanticSim.toFixed(3)}) should be >= 0.30`);
  }
  db.close();
}

// ─── Test 11: rescue respects stale/exclude filters ───
console.log('Test 11: rescue respects stale/exclude filters');
{
  const db = createDb();
  const queryVec = new Float32Array([1.0, 0.0, 0.0]);

  // Stale chunk with high similarity — should be excluded by default
  insertChunkWithEmbedding(db, {
    content: 'old outdated stack info from 2024',
    heading: 'Old Stack',
    embedding: makeVec([0.95, 0.05, 0.0]),
    stale: 1,
  });

  // Active chunk with moderate similarity
  insertChunkWithEmbedding(db, {
    content: 'current active protocol for daily routine',
    heading: 'Active',
    embedding: makeVec([0.60, 0.40, 0.0]),
  });

  const results = recall(db, 'daily routine info', { limit: 10, queryEmbedding: queryVec });
  const staleHit = results.find(r => r.content.includes('outdated'));
  assert(!staleHit, 'Rescued chunks should respect stale exclusion');

  // With includeStale, the stale chunk should appear
  const withStale = recall(db, 'daily routine info', { limit: 10, queryEmbedding: queryVec, includeStale: true });
  const staleFound = withStale.find(r => r.content.includes('outdated'));
  assert(staleFound != null, 'Rescued stale chunk should appear when includeStale=true');
  db.close();
}

// ─── Test 12: pure-semantic fallback when all stop words ───
console.log('Test 12: pure-semantic fallback when FTS query is all stop words');
{
  const db = createDb();
  const queryVec = new Float32Array([1.0, 0.0, 0.0]);

  insertChunkWithEmbedding(db, {
    content: 'important decision about project architecture',
    heading: 'Architecture',
    embedding: makeVec([0.85, 0.15, 0.0]),
  });

  // "is the" sanitizes to null (all stop words removed by FTS sanitizer)
  // But with queryEmbedding, rescue should still find relevant chunks
  const results = recall(db, 'is the', { limit: 10, queryEmbedding: queryVec });
  assert(results.length >= 1, `Pure-semantic fallback should find results, got ${results.length}`);

  // Without embedding, this returns empty (no FTS terms)
  const noEmb = recall(db, 'is the', { limit: 10 });
  assert(noEmb.length === 0, `Without embedding, stop-word query should return empty, got ${noEmb.length}`);
  db.close();
}

// ─── Test 13: rankResults accepts profile parameter ───
console.log('Test 13: rankResults accepts profile parameter');
{
  const now = new Date().toISOString();
  const rows = [
    { rank: -10, file_weight: 1.0, confidence: 1.0, created_at: now, content: 'test', heading: 'A', file_path: 'a.md', line_start: 1, line_end: 5, chunk_type: 'fact', entities: '[]', _semanticSim: 0.9 },
  ];

  const withDefault = rankResults([...rows]);
  const withRecall = rankResults([...rows], RECALL_PROFILE);
  const withSemantic = rankResults([...rows].map(r => ({ ...r })), RECALL_SEMANTIC_PROFILE);

  assert(withDefault.length === 1, 'Default profile should work');
  assert(withRecall.length === 1, 'Explicit RECALL_PROFILE should work');
  assert(withSemantic.length === 1, 'RECALL_SEMANTIC_PROFILE should work');

  // Semantic profile should produce a different score since it weights semantic at 0.30
  assert(withSemantic[0].finalScore !== withRecall[0].finalScore,
    `Semantic profile score (${withSemantic[0].finalScore.toFixed(4)}) should differ from recall (${withRecall[0].finalScore.toFixed(4)})`);
}

// ─── Test 14: Temporal query "yesterday" applies date filtering + file boost ───
console.log('Test 14: Temporal "yesterday" applies date filtering and boost');
{
  const db = createDb();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const weekAgoStr = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().split('T')[0]; })();

  // Insert chunks: one from yesterday's file, one from a week ago
  insertChunks(db, `memory/${yesterdayStr}.md`, 1000, [
    { heading: 'Log', content: 'deployed new feature to production server', lineStart: 1, lineEnd: 5, entities: [] },
  ], yesterday.toISOString());
  insertChunks(db, `memory/${weekAgoStr}.md`, 1000, [
    { heading: 'Log', content: 'deployed hotfix to staging server', lineStart: 1, lineEnd: 5, entities: [] },
  ], new Date(Date.now() - 7 * 86400000).toISOString());

  const results = recall(db, 'what was deployed yesterday', { limit: 10 });
  assert(results.length >= 1, `Temporal query should return results, got ${results.length}`);
  // Yesterday's chunk should rank first due to temporal date boost
  if (results.length >= 2) {
    assert(results[0].filePath.includes(yesterdayStr), `Yesterday file should rank first, got ${results[0].filePath}`);
  }
  db.close();
}

// ─── Test 15: Temporal query with empty stripped query uses date-range fallback ───
console.log('Test 15: Date-range fallback for temporal-only queries');
{
  const db = createDb();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  insertChunks(db, `memory/${yesterdayStr}.md`, 1000, [
    { heading: 'Notes', content: 'morning standup meeting with the team about quarterly goals', lineStart: 1, lineEnd: 5, entities: [] },
  ], yesterday.toISOString());
  insertChunks(db, 'memory/2026-01-01.md', 1000, [
    { heading: 'Notes', content: 'new year planning session for the team quarterly goals', lineStart: 1, lineEnd: 5, entities: [] },
  ], '2026-01-01T12:00:00.000Z');

  // "about yesterday" — "about" is a stop word, strippedQuery becomes just stop words → null
  // This should trigger date-range fallback
  const results = recall(db, 'about yesterday', { limit: 10 });
  assert(results.length >= 1, `Date-range fallback should return results, got ${results.length}`);
  if (results.length >= 1) {
    assert(results[0].filePath.includes(yesterdayStr), `Should find yesterday's chunk, got ${results[0].filePath}`);
  }
  db.close();
}

// ─── Test 16: Intent type boost applies to scored results ───
console.log('Test 16: Intent type boost for action queries');
{
  const db = createDb();
  const recent = daysAgo(1);

  insertChunks(db, 'memory/tasks.md', 1000, [
    { heading: 'Tasks', content: 'action item: review pull request for auth module', lineStart: 1, lineEnd: 5, entities: [], chunkType: 'action_item' },
    { heading: 'Notes', content: 'discussed auth module architecture in review meeting', lineStart: 6, lineEnd: 10, entities: [], chunkType: 'raw' },
    { heading: 'Decisions', content: 'decided to use JWT for auth module token review', lineStart: 11, lineEnd: 15, entities: [], chunkType: 'decision' },
  ], recent);

  const results = recall(db, "what should I review next", { limit: 10 });
  assert(results.length >= 1, `Intent query should return results, got ${results.length}`);
  // action_item and decision chunks should get boosted for "what should I" queries
  const actionIdx = results.findIndex(r => r.chunkType === 'action_item');
  const rawIdx = results.findIndex(r => r.chunkType === 'raw');
  if (actionIdx >= 0 && rawIdx >= 0) {
    assert(actionIdx < rawIdx, `action_item should rank above raw after intent boost (action=${actionIdx}, raw=${rawIdx})`);
  }
  db.close();
}

// ─── Test 17: Rule penalty demotes rule chunks for factual queries ───
console.log('Test 17: Rule penalty demotes rule chunks');
{
  const db = createDb();
  const recent = daysAgo(1);

  insertChunks(db, 'memory/rules.md', 1000, [
    { heading: 'Rules', content: 'hard rule: never commit supplements data without approval. mandatory review required.', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);
  insertChunks(db, 'memory/health.md', 1000, [
    { heading: 'Stack', content: 'supplements stack: magnesium glycinate 400mg, zinc 30mg, vitamin D 5000IU', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  const results = recall(db, 'supplements', { limit: 10 });
  assert(results.length >= 2, `Should find both chunks, got ${results.length}`);
  // The factual chunk should rank above the rule chunk after penalty
  const ruleResult = results.find(r => r.content.includes('hard rule'));
  const factResult = results.find(r => r.content.includes('magnesium'));
  if (ruleResult && factResult) {
    assert(factResult.score >= ruleResult.score, `Factual chunk (${factResult.score.toFixed(4)}) should score >= rule chunk (${ruleResult.score.toFixed(4)})`);
  }
  db.close();
}

// ─── Test 18: Non-temporal query unchanged (regression) ───
console.log('Test 18: Non-temporal query regression');
{
  const db = createDb();
  insertChunks(db, 'test.md', 1000, [
    { heading: 'Protocol', content: 'magnesium glycinate supplement before bed', lineStart: 1, lineEnd: 5, entities: [] },
    { heading: 'Stack', content: 'zinc picolinate morning routine daily', lineStart: 6, lineEnd: 10, entities: [] },
  ], daysAgo(5));

  const results = recall(db, 'magnesium', { limit: 10 });
  assert(results.length >= 1, `Should find results, got ${results.length}`);
  assert(results[0].content.includes('magnesium'), `First result should contain magnesium, got: ${results[0].content}`);
  assert(typeof results[0].finalScore === 'number', 'Should have finalScore');
  assert(typeof results[0].score === 'number', 'Should have score');
  assert(results[0].finalScore > 0, 'Score should be positive');
  db.close();
}

// ─── Test 19: Rescue sorts by similarity, not DB insertion order ───
console.log('Test 19: rescue pass returns highest-similarity chunks regardless of DB order');
{
  const db = createDb();
  const queryVec = new Float32Array([1.0, 0.0, 0.0]);

  // Insert 15 low-similarity chunks first (earlier in DB order)
  for (let i = 0; i < 15; i++) {
    insertChunkWithEmbedding(db, {
      content: `low similarity noise chunk ${i} about random topics`,
      heading: `Noise ${i}`,
      embedding: makeVec([0.20 + i * 0.01, 0.80 - i * 0.01, 0.0]),
      filePath: `noise-${i}.md`,
    });
  }

  // Insert high-similarity chunk LAST (late DB position)
  insertChunkWithEmbedding(db, {
    content: 'Critical high-value chunk about portfolio framework',
    heading: 'Portfolio Framework',
    filePath: 'MEMORY.md',
    fileWeight: 1.5,
    embedding: makeVec([0.95, 0.05, 0.0]),
  });

  // Query with no FTS matches — all results come from rescue pass
  const results = recall(db, 'xyzzy', { limit: 10, queryEmbedding: queryVec });
  const memoryChunk = results.find(r => r.filePath === 'MEMORY.md');
  assert(memoryChunk != null, 'Rescue should find MEMORY.md despite late DB position');
  if (memoryChunk) {
    assert(memoryChunk.semanticSim >= 0.90, `MEMORY.md sim (${memoryChunk.semanticSim.toFixed(3)}) should be >= 0.90`);
    // Should be #1 since it has the highest similarity
    assert(results[0].filePath === 'MEMORY.md', `MEMORY.md should be first result, got ${results[0].filePath}`);
  }
  db.close();
}

// ─── Test 20: OR query runs even when AND returns results ───
console.log('Test 20: OR query runs even when AND returns results');
{
  const db = createDb();
  const recent = daysAgo(1);

  // Chunk that matches AND for "portfolio allocation framework"
  insertChunks(db, 'memory/spec.md', 1000, [
    { heading: 'Spec', content: 'portfolio allocation framework detailed specification document', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  // Chunk that matches "portfolio" and "framework" but NOT "allocation" — AND misses, OR finds
  insertChunks(db, 'MEMORY.md', 1000, [
    { heading: 'Portfolio Framework', content: 'portfolio framework with 60% equities 30% bonds 10% alternatives', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  const results = recall(db, 'portfolio allocation framework', { limit: 10 });
  assert(results.length >= 2, `Both AND and OR results should appear, got ${results.length}`);
  const memoryHit = results.find(r => r.filePath === 'MEMORY.md');
  assert(memoryHit != null, 'OR query should surface MEMORY.md despite partial AND match');
  db.close();
}

// ─── Test 21: Self-reference penalty on spec/test chunks ───
console.log('Test 21: chunks containing literal query in spec context get penalized');
{
  const db = createDb();
  const recent = daysAgo(1);

  insertChunks(db, 'data/sme-spec.md', 1000, [
    { heading: 'Test Queries', content: 'test query: what supplements is JB taking? expected: MEMORY.md Current Stack in top 2 results. benchmark score target: 9/10.', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);
  insertChunks(db, 'memory/health.md', 1000, [
    { heading: 'Supplements', content: 'JB current supplement stack: creatine 5g, magnesium glycinate 400mg, zinc picolinate 30mg daily', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  const results = recall(db, 'what supplements is JB taking', { limit: 10 });
  assert(results.length >= 2, `Should find both chunks, got ${results.length}`);
  const specResult = results.find(r => r.filePath === 'data/sme-spec.md');
  const healthResult = results.find(r => r.filePath === 'memory/health.md');
  if (specResult && healthResult) {
    assert(healthResult.score > specResult.score, `Health chunk (${healthResult.score.toFixed(4)}) should outrank spec chunk (${specResult.score.toFixed(4)}) after self-reference penalty`);
  }
  db.close();
}

// ─── Test 22: Temporal boost — single-day query dominates over keyword match ───
console.log('Test 22: Temporal boost — single-day query dominates over keyword match');
{
  const db = createDb();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  // Yesterday's file with content about a deployment
  insertChunks(db, `memory/${yesterdayStr}.md`, 1000, [
    { heading: 'Session Log', content: 'deployed consensus research update and reviewed pull requests', lineStart: 1, lineEnd: 5, entities: [] },
    { heading: 'Decisions', content: 'decided to deploy the new query pipeline for better performance', lineStart: 6, lineEnd: 10, entities: [] },
  ], yesterday.toISOString());

  // Old file with strong keyword match for "deployed"
  insertChunks(db, 'MEMORY.md', 1000, [
    { heading: 'Deployments', content: 'deployed major update to the production server infrastructure', lineStart: 1, lineEnd: 5, entities: [] },
  ], daysAgo(30));

  const results = recall(db, 'what was deployed yesterday', { limit: 5 });
  assert(results.length >= 1, `Should have results, got ${results.length}`);
  // Top result should be from yesterday's file due to temporal boost
  assert(results[0].filePath.includes(yesterdayStr),
    `Top result should be from yesterday (${yesterdayStr}), got ${results[0].filePath}`);
  // If both files returned, yesterday should dominate
  const memoryMd = results.find(r => r.filePath === 'MEMORY.md');
  if (memoryMd) {
    assert(results[0].score > memoryMd.score * 2,
      `Yesterday's score should be >2x MEMORY.md score`);
  }
  db.close();
}

// ─── Test 23: Heading boost — query term in heading ranks higher ───
console.log('Test 23: Heading boost — query term in heading ranks higher');
{
  const db = createDb();
  const recent = daysAgo(2);

  // Chunk with "creatine" in heading AND body
  insertChunks(db, 'MEMORY.md', 1000, [
    { heading: 'Creatine Protocol', content: 'creatine monohydrate 5g dosage taken with water daily', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  // Chunk with "creatine" only in body (similar content)
  insertChunks(db, 'USER.md', 1000, [
    { heading: 'Supplements', content: 'creatine monohydrate 5g dosage taken with juice daily', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  const results = recall(db, 'creatine dosage', { limit: 5 });
  assert(results.length >= 2, `Should find both chunks, got ${results.length}`);
  // The chunk with "creatine" in heading should rank higher due to heading boost
  const headingMatch = results.find(r => r.heading === 'Creatine Protocol');
  const bodyMatch = results.find(r => r.heading === 'Supplements');
  if (headingMatch && bodyMatch) {
    assert(headingMatch.score > bodyMatch.score,
      `Heading match (${headingMatch.score.toFixed(3)}) should rank > body match (${bodyMatch.score.toFixed(3)})`);
  }
  db.close();
}

// ─── Test 24: Heading boost — no effect when no heading matches ───
console.log('Test 24: Heading boost — no effect when query terms not in headings');
{
  const db = createDb();
  const recent = daysAgo(1);

  insertChunks(db, 'MEMORY.md', 1000, [
    { heading: 'Morning Routine', content: 'takes magnesium before bed for sleep quality improvement', lineStart: 1, lineEnd: 5, entities: [] },
    { heading: 'Evening Routine', content: 'reads about magnesium research papers and dosing protocols', lineStart: 6, lineEnd: 10, entities: [] },
  ], recent);

  const results = recall(db, 'magnesium dosing', { limit: 5 });
  // Both chunks match "magnesium" in content, neither has it in heading — no heading boost applied
  assert(results.length >= 1, `Should find results, got ${results.length}`);
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
