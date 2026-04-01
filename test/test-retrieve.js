#!/usr/bin/env node
/**
 * Tests for retrieve.js — shared retrieval pipeline used by both recall() and getRelevantContext().
 */
const Database = require('better-sqlite3');
const { SCHEMA, insertChunks } = require('../lib/store');
const { retrieveChunks, sanitizeFtsQuery, buildOrQuery, buildTemporalExpansion, loadAliases, VAGUE_QUERY_WORDS, TEMPORAL_EXPANSION_TERMS } = require('../lib/retrieve');
const { recall } = require('../lib/recall');
const { getRelevantContext } = require('../lib/context');
const { ensureEmbeddingColumn } = require('../lib/embeddings');

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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── Test 1: retrieveChunks returns expected shape ───
console.log('Test 1: retrieveChunks returns expected shape');
{
  const db = createDb();
  insertChunks(db, 'test.md', 1000, [
    { heading: 'Protocol', content: 'magnesium glycinate supplement before bed', lineStart: 1, lineEnd: 5, entities: [] },
  ], daysAgo(3));

  const result = retrieveChunks(db, 'magnesium', { limit: 10 });
  assert(result.rows != null, 'Should have rows array');
  assert(result.temporal != null, 'Should have temporal object');
  assert(result.intent != null || result.intent === null, 'Should have intent');
  assert(typeof result.totalFetched === 'number', 'Should have totalFetched count');
  assert(result.rows.length >= 1, `Should find at least 1 row, got ${result.rows.length}`);
  assert(result.rows[0]._normalizedFts != null, 'Rows should have _normalizedFts annotation');
  db.close();
}

// ─── Test 2: Both recall() and getRelevantContext() use the shared pipeline ───
console.log('Test 2: Both callers find the same content via shared pipeline');
{
  const db = createDb();
  const recent = daysAgo(1);
  insertChunks(db, 'memory/health.md', 1000, [
    { heading: 'Stack', content: 'creatine monohydrate 5g daily morning routine', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  const recallResults = recall(db, 'creatine routine', { limit: 10 });
  const contextResult = getRelevantContext(db, 'creatine routine');

  assert(recallResults.length >= 1, `recall should find results, got ${recallResults.length}`);
  assert(contextResult.chunks.length >= 1, `context should find results, got ${contextResult.chunks.length}`);

  // Both should find the same chunk
  const recallContent = recallResults[0].content;
  const contextContent = contextResult.chunks[0].content;
  assert(recallContent.includes('creatine'), `recall content should include creatine: ${recallContent.slice(0, 50)}`);
  assert(contextContent.includes('creatine'), `context content should include creatine: ${contextContent.slice(0, 50)}`);
  db.close();
}

// ─── Test 3: AND-match annotation set correctly ───
console.log('Test 3: AND-match annotation distinguishes precision vs recall hits');
{
  const db = createDb();
  const recent = daysAgo(1);

  // Chunk matching both "portfolio" AND "allocation"
  insertChunks(db, 'memory/spec.md', 1000, [
    { heading: 'Spec', content: 'portfolio allocation framework detailed specification', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  // Chunk matching only "portfolio" (OR hit via alias)
  insertChunks(db, 'MEMORY.md', 1000, [
    { heading: 'Portfolio', content: 'portfolio framework 60% equities 30% bonds', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  const result = retrieveChunks(db, 'portfolio allocation', { limit: 30 });
  assert(result.rows.length >= 2, `Should find both rows, got ${result.rows.length}`);

  const andHit = result.rows.find(r => r.content.includes('allocation'));
  const orHit = result.rows.find(r => r.content.includes('equities'));
  if (andHit) assert(andHit._andMatch === true, 'AND hit should have _andMatch = true');
  if (orHit) assert(orHit._andMatch === false, 'OR-only hit should have _andMatch = false');
  db.close();
}

// ─── Test 4: Exclusion filtering works ───
console.log('Test 4: Exclusion filtering removes matching files');
{
  const db = createDb();
  insertChunks(db, 'data/sme-spec.md', 1000, [
    { heading: 'Spec', content: 'magnesium protocol benchmark specification document', lineStart: 1, lineEnd: 5, entities: [] },
  ], daysAgo(1));
  insertChunks(db, 'memory/health.md', 1000, [
    { heading: 'Stack', content: 'magnesium glycinate 400mg daily supplement protocol', lineStart: 1, lineEnd: 5, entities: [] },
  ], daysAgo(1));

  const withExclude = retrieveChunks(db, 'magnesium protocol', {
    limit: 30,
    excludePatterns: ['data/sme-spec.md'],
  });
  const specHit = withExclude.rows.find(r => r.file_path.includes('sme-spec'));
  assert(!specHit, 'Excluded file should not appear in results');

  const healthHit = withExclude.rows.find(r => r.file_path.includes('health'));
  assert(healthHit != null, 'Non-excluded file should still appear');
  db.close();
}

// ─── Test 5: orInput allows search when raw query sanitizes to nothing ───
console.log('Test 5: orInput enables search when raw query is all stop words');
{
  const db = createDb();
  insertChunks(db, 'test.md', 1000, [
    { heading: 'Stack', content: 'creatine monohydrate 5g daily protocol', lineStart: 1, lineEnd: 5, entities: [] },
  ], daysAgo(1));

  // "what about that?" sanitizes to null (all stop words)
  const withoutOrInput = retrieveChunks(db, 'what about that?', { limit: 30 });
  assert(withoutOrInput.rows.length === 0, `Without orInput, stop-word query should return empty, got ${withoutOrInput.rows.length}`);

  // With orInput providing real terms
  const withOrInput = retrieveChunks(db, 'what about that?', {
    limit: 30,
    orInput: 'creatine protocol',
  });
  assert(withOrInput.rows.length >= 1, `With orInput, should find results, got ${withOrInput.rows.length}`);
  db.close();
}

// ─── Test 6: extraOrQueries run additional searches ───
console.log('Test 6: extraOrQueries add results from additional searches');
{
  const db = createDb();
  const recent = daysAgo(1);
  insertChunks(db, 'memory/health.md', 1000, [
    { heading: 'Stack', content: 'zinc picolinate 30mg supplement morning', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);
  insertChunks(db, 'memory/work.md', 1000, [
    { heading: 'Tasks', content: 'deploy production server update deployment', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  // Base query only finds zinc
  const baseResult = retrieveChunks(db, 'zinc supplement', { limit: 30 });
  const hasZinc = baseResult.rows.some(r => r.content.includes('zinc'));
  assert(hasZinc, 'Base query should find zinc');

  // With extra OR query, also finds deploy
  const withExtra = retrieveChunks(db, 'zinc supplement', {
    limit: 30,
    extraOrQueries: [{ query: '"deploy" OR "production"' }],
  });
  const hasDeploy = withExtra.rows.some(r => r.content.includes('deploy'));
  assert(hasDeploy, 'Extra OR query should surface deploy chunk');
  assert(withExtra.rows.length > baseResult.rows.length, 'Extra queries should increase result count');
  db.close();
}

// ─── Test 7: Temporal resolution works through retrieve.js ───
console.log('Test 7: Temporal resolution filters by resolved dates');
{
  const db = createDb();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  insertChunks(db, `memory/${yesterdayStr}.md`, 1000, [
    { heading: 'Log', content: 'deployed feature to production server update', lineStart: 1, lineEnd: 5, entities: [] },
  ], yesterday.toISOString());
  insertChunks(db, 'memory/2025-01-01.md', 1000, [
    { heading: 'Log', content: 'old deployment to staging server archive', lineStart: 1, lineEnd: 5, entities: [] },
  ], '2025-01-01T12:00:00.000Z');

  const result = retrieveChunks(db, 'what was deployed yesterday', { limit: 30 });
  assert(result.temporal.dateTerms.length > 0, 'Should resolve temporal date terms');
  assert(result.rows.length >= 1, 'Should find results');
  db.close();
}

// ─── Test 8: Regression — fix in retrieve.js propagates to both callers ───
console.log('Test 8: Shared pipeline ensures both callers see identical FTS results');
{
  const db = createDb();
  const recent = daysAgo(1);
  insertChunks(db, 'memory/unique.md', 1000, [
    { heading: 'Unique', content: 'xylophone orchestral arrangement musical performance', lineStart: 1, lineEnd: 5, entities: [] },
  ], recent);

  // Both callers should find this via the same shared FTS pipeline
  const recallHits = recall(db, 'xylophone arrangement', { limit: 10 });
  const contextHits = getRelevantContext(db, 'xylophone arrangement');

  assert(recallHits.length >= 1, `recall should find xylophone, got ${recallHits.length}`);
  assert(contextHits.chunks.length >= 1, `context should find xylophone, got ${contextHits.chunks.length}`);

  // Both found the same content
  if (recallHits.length > 0 && contextHits.chunks.length > 0) {
    assert(recallHits[0].content === contextHits.chunks[0].content,
      'Both callers should return identical content from shared pipeline');
  }
  db.close();
}

// ─── Test: FTS-empty temporal fallback ───
{
  console.log('\nTest: FTS returns 0 but temporal dates resolved → fallback to date-range scan');
  const db = createDb();
  // Insert a chunk dated 2025-03-05 (a Wednesday)
  const chunks = [{ content: 'Had a great team standup and planned the sprint', chunkType: 'raw', heading: null }];
  insertChunks(db, 'memory/2025-03-05.md', Date.now(), chunks, '2025-03-05T10:00:00.000Z');

  // Insert another chunk on a different date
  const other = [{ content: 'Reviewed pull requests and deployed staging', chunkType: 'raw', heading: null }];
  insertChunks(db, 'memory/2025-03-06.md', Date.now(), other, '2025-03-06T10:00:00.000Z');

  // Query with temporal date + unmatchable keyword — "accomplish" won't FTS-match anything
  const result = retrieveChunks(db, 'what did I accomplish on Wednesday', {
    limit: 10,
    temporal: {
      strippedQuery: 'accomplish',
      since: '2025-03-05',
      until: '2025-03-06',
      dateTerms: ['wednesday'],
      forwardLooking: false,
    },
  });

  assert(result.rows.length >= 1, `should fallback to date-range scan, got ${result.rows.length} rows`);
  if (result.rows.length > 0) {
    assert(result.rows[0].content.includes('team standup'),
      'should return the chunk from the resolved date');
  }

  // Verify: when FTS DOES match, no fallback needed (normal path)
  const result2 = retrieveChunks(db, 'standup on Wednesday', {
    limit: 10,
    temporal: {
      strippedQuery: 'standup',
      since: '2025-03-05',
      until: '2025-03-06',
      dateTerms: ['wednesday'],
      forwardLooking: false,
    },
  });
  assert(result2.rows.length >= 1, `FTS match path should still work, got ${result2.rows.length} rows`);

  db.close();
}

// ─── Test: buildTemporalExpansion ───
{
  console.log('\nTest: buildTemporalExpansion');

  // 1. Vague temporal query triggers expansion
  const result1 = buildTemporalExpansion('accomplish', { dateTerms: ['2025-03-05'], since: '2025-03-05' });
  assert(result1 !== null, 'vague temporal query should trigger expansion');
  assert(result1.includes('"built"'), 'expansion should include action verbs');
  assert(result1.includes('"accomplish"'), 'expansion should include original term');
  assert(result1.includes(' OR '), 'expansion should use OR logic');

  // 2. Specific temporal query does NOT trigger expansion
  const result2 = buildTemporalExpansion('deployment strategy', { dateTerms: ['2025-03-05'], since: '2025-03-05' });
  assert(result2 === null, 'specific query should NOT trigger expansion');

  // 3. Non-temporal query does NOT trigger expansion
  const result3 = buildTemporalExpansion('accomplish', { dateTerms: [], since: null });
  assert(result3 === null, 'non-temporal query should NOT trigger expansion');

  // 4. Mixed vague + specific does NOT trigger expansion
  const result4 = buildTemporalExpansion('accomplish deployment', { dateTerms: ['2025-03-05'], since: '2025-03-05' });
  assert(result4 === null, 'mixed vague+specific should NOT trigger expansion');

  // 5. All stop words stripped → no expansion (tokens.length === 0)
  const result5 = buildTemporalExpansion('what did I', { dateTerms: ['2025-03-05'], since: '2025-03-05' });
  assert(result5 === null, 'all-stopwords should NOT trigger expansion');

  // 6. Multiple vague words still trigger
  const result6 = buildTemporalExpansion('work done', { dateTerms: ['2025-03-05'], since: '2025-03-05' });
  assert(result6 !== null, 'multiple vague words should trigger expansion');

  // 7. Null strippedQuery
  const result7 = buildTemporalExpansion(null, { dateTerms: ['2025-03-05'], since: '2025-03-05' });
  assert(result7 === null, 'null query should not trigger expansion');
}

// ─── Test: Temporal expansion in retrieval pipeline ───
{
  console.log('\nTest: Temporal expansion finds chunks via action verbs');
  const db = createDb();

  // Insert a chunk with action verb content on a specific date
  const chunks = [{ content: 'Built the new authentication system and deployed it to staging', chunkType: 'raw', heading: null }];
  insertChunks(db, 'memory/2025-03-05.md', Date.now(), chunks, '2025-03-05T10:00:00.000Z');

  // Query with vague temporal keyword — "accomplish" won't match, but expansion adds "built" and "deployed"
  const result = retrieveChunks(db, 'what did I accomplish on Wednesday', {
    limit: 10,
    temporal: {
      strippedQuery: 'accomplish',
      since: '2025-03-05',
      until: '2025-03-06',
      dateTerms: ['2025-03-05'],
      forwardLooking: false,
    },
  });

  assert(result.rows.length >= 1, `expansion should find chunks via action verbs, got ${result.rows.length}`);
  if (result.rows.length > 0) {
    assert(result.rows[0].content.includes('authentication'),
      'should find the chunk with action verbs');
  }

  // Non-vague temporal query — should still use normal FTS path
  const result2 = retrieveChunks(db, 'authentication system on Wednesday', {
    limit: 10,
    temporal: {
      strippedQuery: 'authentication system',
      since: '2025-03-05',
      until: '2025-03-06',
      dateTerms: ['2025-03-05'],
      forwardLooking: false,
    },
  });
  assert(result2.rows.length >= 1, `specific query should still find via FTS, got ${result2.rows.length}`);

  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
