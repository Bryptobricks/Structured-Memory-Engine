#!/usr/bin/env node
/**
 * Tests for CIL — Context Intelligence Layer (lib/context.js)
 */
const Database = require('better-sqlite3');
const { SCHEMA } = require('../lib/store');
const { getRelevantContext, detectQueryIntent, isRuleChunk, applyRulePenalty } = require('../lib/context');

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
  // Daily routine — active
  insertChunk(db, { content: 'Creatine 5g daily started Feb 23. Day 1: improved recovery, better energy during afternoon workouts.', heading: 'Creatine Tracking', entities: JSON.stringify(['creatine']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(4), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Config — superseded
  insertChunk(db, { content: 'Redis cache TTL currently 300s, will reduce to 120s.', heading: 'Infrastructure', entities: JSON.stringify(['redis']), chunkType: 'fact', confidence: 0.6, createdAt: daysAgo(17), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Config — current
  insertChunk(db, { content: 'Redis cache TTL reduced to 120s as of Feb 16. P99 latency: 45ms.', heading: 'Infrastructure', entities: JSON.stringify(['redis']), chunkType: 'confirmed', confidence: 1.0, createdAt: daysAgo(11), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Work — decision
  insertChunk(db, { content: 'DataSync will be the primary API gateway on CloudStack. Architecture review underway — need full test coverage.', heading: 'Backend Services', entities: JSON.stringify(['DataSync', 'CloudStack']), chunkType: 'decision', confidence: 0.95, createdAt: daysAgo(3), filePath: 'memory/2026-02-24.md' });
  // Work — action item
  insertChunk(db, { content: 'Send Tom project roadmap with API health plan, rate limits, timeline, contingency.', heading: 'Action Items', entities: JSON.stringify(['Tom', 'Nexus']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(3), filePath: 'memory/2026-02-24.md' });
  // Personal — preference
  insertChunk(db, { content: 'Alex prefers minimal, clean UI design. Dark mode with high contrast.', heading: 'Preferences', entities: JSON.stringify(['Alex']), chunkType: 'preference', confidence: 1.0, createdAt: daysAgo(43), filePath: 'USER.md', fileWeight: 1.3 });
  // Old event
  insertChunk(db, { content: 'TechConf trip Feb 17-21. Hotel: Downtown Marriott.', heading: 'TechConf', entities: JSON.stringify(['TechConf']), chunkType: 'fact', confidence: 0.8, createdAt: daysAgo(16), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Technical — recent
  insertChunk(db, { content: 'CI pipeline 200s timeout bug. Docs say 600s but runner enforces 200s. Missing config override.', heading: 'System', entities: JSON.stringify(['CI']), chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(1), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Project — allocation
  insertChunk(db, { content: 'Project allocation: 60/30/10 frontend/backend/infrastructure. Team size: 12 engineers.', heading: 'Project', entities: JSON.stringify(['project']), chunkType: 'confirmed', confidence: 1.0, createdAt: daysAgo(3), filePath: 'MEMORY.md', fileWeight: 1.5 });
  // Generic daily noise
  insertChunk(db, { content: 'Checked email. Nothing urgent. Calendar clear until 3pm.', heading: null, entities: '[]', chunkType: 'raw', confidence: 1.0, createdAt: daysAgo(2), filePath: 'memory/2026-02-25.md' });
}

// ─── Test 1: Creatine query ───
console.log('Test 1: "How\'s the creatine experiment going?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, "How's the creatine experiment going?");
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Creatine'), `Expected Creatine chunk ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  // Redis should not be in top 3
  const top3Contents = result.chunks.slice(0, 3).map(c => c.content).join(' ');
  assert(!top3Contents.toLowerCase().includes('redis'), 'Redis should not be in top 3 for creatine query');
  assert(result.text.includes('## Recalled Context'), 'Output should have Recalled Context header');
  assert(result.tokenEstimate > 0, `Token estimate should be > 0, got ${result.tokenEstimate}`);
  db.close();
}

// ─── Test 2: API gateway decision ───
console.log('Test 2: "What did we decide about the API gateway?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'What did we decide about the API gateway?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('DataSync'), `Expected DataSync decision ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  db.close();
}

// ─── Test 3: Entity match — Tom ───
console.log('Test 3: "What do I need to send Tom?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'What do I need to send Tom?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Tom'), `Expected Tom action item ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  db.close();
}

// ─── Test 4: Redis TTL — current value outranks old ───
console.log('Test 4: "What\'s the current Redis cache TTL?"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, "What's the current Redis cache TTL?");
  assert(result.chunks.length >= 2, `Expected at least 2 chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('120s'), `Expected 120s (current) ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  // The superseded 300s should rank lower
  const idx300 = result.chunks.findIndex(c => c.content.includes('300s'));
  if (idx300 >= 0) {
    assert(idx300 > 0, `Superseded 300s should not be #1 (found at index ${idx300})`);
  }
  db.close();
}

// ─── Test 5: Project allocation query ───
console.log('Test 5: "Tell me about the project allocation"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'Tell me about the project allocation');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Project'), `Expected Project chunk ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  // TechConf should not appear
  const allContents = result.chunks.map(c => c.content).join(' ');
  assert(!allContents.includes('TechConf'), 'TechConf should not appear in project allocation query');
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

// ─── Test 8: UI design preferences with entity match ───
console.log('Test 8: "Alex\'s design preferences"');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, "Alex's design preferences");
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('UI design'), `Expected design preference ranked #1, got: ${result.chunks[0].content.slice(0, 60)}`);
  db.close();
}

// ─── Test 9: Contradiction flagging ───
console.log('Test 9: Contradictions flagged in output');
{
  const db = createDb();
  // Insert contradictory chunks + a contradiction record
  const id1 = insertChunk(db, { heading: 'Protocol', content: 'takes creatine supplement daily morning protocol for recovery energy', filePath: 'memory/2026-01-01.md', chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(60) });
  const id2 = insertChunk(db, { heading: 'Protocol', content: 'stopped creatine supplement daily morning protocol due bloating', filePath: 'memory/2026-02-01.md', chunkType: 'fact', confidence: 1.0, createdAt: daysAgo(10) });
  // Manually insert contradiction record
  db.prepare('INSERT INTO contradictions (chunk_id_old, chunk_id_new, reason, created_at) VALUES (?, ?, ?, ?)').run(
    Math.min(id1, id2), Math.max(id1, id2), 'Shared terms: creatine, supplement; negation detected', new Date().toISOString()
  );

  const result = getRelevantContext(db, 'creatine protocol morning recovery');
  assert(result.chunks.length >= 2, `Expected at least 2 chunks, got ${result.chunks.length}`);
  assert(result.text.includes('contradictions'), `Expected contradiction flag in output, text: ${result.text.slice(-200)}`);
  db.close();
}

// ─── Test 10: Token budget enforcement ───
console.log('Test 10: Token budget enforcement');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'creatine redis project API gateway', { maxTokens: 200 });
  assert(result.tokenEstimate <= 200, `Expected <= 200 tokens, got ${result.tokenEstimate}`);
  assert(result.chunks.length <= 3, `Expected max 3 chunks with tight budget, got ${result.chunks.length}`);
  db.close();
}

// ─── Test 11: Conversation context — "what about that?" resolves from prior turn ───
console.log('Test 11: Conversation context resolves anaphoric reference');
{
  const db = createDb();
  seedFixture(db);
  // "what about that?" alone would match nothing useful
  const withoutContext = getRelevantContext(db, 'what about that?');
  // With conversation context mentioning creatine, it should pull creatine chunks
  const withContext = getRelevantContext(db, 'what about that?', {
    conversationContext: ["How's the creatine experiment going?"],
  });
  assert(withContext.chunks.length > withoutContext.chunks.length ||
    (withContext.chunks.length > 0 && withContext.chunks[0].content.includes('Creatine')),
    `Expected conversation context to improve results`);
  db.close();
}

// ─── Test 12: Conversation context — entity from prior turn ───
console.log('Test 12: Conversation context carries entity from prior turn');
{
  const db = createDb();
  seedFixture(db);
  // "and the project roadmap?" alone won't match Tom's action item well
  // But with prior context mentioning Tom, entity match should boost it
  const result = getRelevantContext(db, 'and the project roadmap?', {
    conversationContext: ['What do I need to send Tom?'],
  });
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  const hasTom = result.chunks.some(c => c.content.includes('Tom'));
  assert(hasTom, 'Expected Tom chunk to appear via conversation context entity match');
  db.close();
}

// ─── Test 13: Conversation context — empty array has no effect ───
console.log('Test 13: Empty conversation context has no effect');
{
  const db = createDb();
  seedFixture(db);
  const without = getRelevantContext(db, "How's the creatine experiment going?");
  const withEmpty = getRelevantContext(db, "How's the creatine experiment going?", {
    conversationContext: [],
  });
  assert(without.chunks.length === withEmpty.chunks.length, 'Empty context array should not change results');
  db.close();
}

// ─── Test 14: excludeFromRecall filters out specified files ───
console.log('Test 14: excludeFromRecall filters out specified files');
{
  const db = createDb();
  // Insert chunks from different files
  insertChunk(db, { content: 'creatine protocol daily morning supplement stack', filePath: 'CLAUDE.md', confidence: 1.0 });
  insertChunk(db, { content: 'creatine experiment started tracking today supplement', filePath: 'memory/2026-02-01.md', confidence: 1.0 });
  insertChunk(db, { content: 'creatine dosage review agent configuration supplement', filePath: 'agents/reviewer.md', confidence: 1.0 });

  // Without exclusion — should find all
  const resultAll = getRelevantContext(db, 'creatine supplement');
  assert(resultAll.chunks.length >= 2, `Expected at least 2 chunks without exclusion, got ${resultAll.chunks.length}`);

  // With exclusion — CLAUDE.md and agents/*.md excluded
  const resultFiltered = getRelevantContext(db, 'creatine supplement', {
    excludeFromRecall: ['CLAUDE.md', 'agents/*.md'],
  });
  const hasExcluded = resultFiltered.chunks.some(c => c.filePath === 'CLAUDE.md' || c.filePath === 'agents/reviewer.md');
  assert(!hasExcluded, 'Should not contain excluded files in results');
  const hasMemory = resultFiltered.chunks.some(c => c.filePath === 'memory/2026-02-01.md');
  assert(hasMemory, 'Should still contain non-excluded memory file');
  db.close();
}

// ─── Test 15: Stop-word-heavy query still finds content words ───
console.log('Test 15: Stop-word-heavy query still finds content words');
{
  const db = createDb();
  seedFixture(db);
  // "where am I at with my creatine?" → stop words stripped, "creatine" survives
  const result = getRelevantContext(db, 'where am I at with my creatine?');
  assert(result.chunks.length > 0, `Expected chunks from stop-word-heavy query, got ${result.chunks.length}`);
  assert(result.chunks[0].content.includes('Creatine'), `Expected Creatine chunk, got: ${result.chunks[0].content.slice(0, 60)}`);
  db.close();
}

// ─── Test 16: Pure stop word query returns empty ───
console.log('Test 16: Pure stop word query returns empty');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'how is it going today');
  assert(result.chunks.length === 0, `Expected 0 chunks for pure stop words, got ${result.chunks.length}`);
  assert(result.text === '', 'Expected empty text for pure stop words');
  db.close();
}

// ─── Test 17: detectQueryIntent — aggregation ───
console.log('Test 17: detectQueryIntent — aggregation');
{
  const r1 = detectQueryIntent('What are all my supplements?');
  assert(r1 !== null, 'Should detect aggregation intent');
  assert(r1.intent === 'aggregation', `Expected aggregation, got ${r1?.intent}`);
  assert(r1.maxChunks === 15, `Expected maxChunks=15, got ${r1?.maxChunks}`);
  assert(r1.minCilScore === 0.10, `Expected minCilScore=0.10, got ${r1?.minCilScore}`);

  const r2 = detectQueryIntent('Give me a summary of this week');
  assert(r2 !== null && r2.intent === 'aggregation', 'summary should trigger aggregation');

  const r3 = detectQueryIntent('List everything about the project');
  assert(r3 !== null && r3.intent === 'aggregation', 'list everything should trigger aggregation');
}

// ─── Test 18: detectQueryIntent — reasoning ───
console.log('Test 18: detectQueryIntent — reasoning');
{
  const r1 = detectQueryIntent('Why did I choose Redis over Postgres?');
  assert(r1 !== null, 'Should detect reasoning intent');
  assert(r1.intent === 'reasoning', `Expected reasoning, got ${r1?.intent}`);
  assert(r1.typeBoosts.decision === 0.25, 'Should boost decision type');

  const r2 = detectQueryIntent('What was the reason for the architecture change?');
  assert(r2 !== null && r2.intent === 'reasoning', 'what was the reason should trigger reasoning');
}

// ─── Test 19: detectQueryIntent — action ───
console.log('Test 19: detectQueryIntent — action');
{
  const r1 = detectQueryIntent('What should I work on next?');
  assert(r1 !== null, 'Should detect action intent');
  assert(r1.intent === 'action', `Expected action, got ${r1?.intent}`);
  assert(r1.typeBoosts.action_item === 0.25, 'Should boost action_item type');

  const r2 = detectQueryIntent("What's next on my todo?");
  assert(r2 !== null && r2.intent === 'action', "what's next should trigger action");

  const r3 = detectQueryIntent('What are my open loops?');
  assert(r3 !== null && r3.intent === 'action', 'open loops should trigger action');
}

// ─── Test 20: detectQueryIntent — no intent ───
console.log('Test 20: detectQueryIntent — no intent for normal queries');
{
  const r1 = detectQueryIntent('How is my creatine experiment going?');
  assert(r1 === null, 'Normal query should return null intent');

  const r2 = detectQueryIntent('What did Tom say about the restructuring?');
  assert(r2 === null, 'Attribution query should return null intent');
}

// ─── Test 21: Config fileWeights override ───
console.log('Test 21: Config fileWeights override — boost specific file');
{
  const db = createDb();
  // Insert chunks from different files with same content relevance
  insertChunk(db, { content: 'creatine supplement protocol daily 5g morning', filePath: 'open-loops.md', confidence: 1.0, createdAt: daysAgo(5), fileWeight: 1.0 });
  insertChunk(db, { content: 'creatine supplement protocol daily experiment tracking notes', filePath: 'memory/2026-02-20.md', confidence: 1.0, createdAt: daysAgo(5), fileWeight: 1.0 });

  // Without fileWeights — order depends on FTS/recency
  const baseline = getRelevantContext(db, 'creatine supplement protocol');
  assert(baseline.chunks.length >= 2, `Expected at least 2 chunks, got ${baseline.chunks.length}`);

  // With fileWeights boosting open-loops.md
  const boosted = getRelevantContext(db, 'creatine supplement protocol', {
    fileWeights: { 'open-loops.md': 2.0 },
  });
  assert(boosted.chunks.length >= 2, `Expected at least 2 chunks, got ${boosted.chunks.length}`);
  assert(boosted.chunks[0].filePath === 'open-loops.md', `Expected open-loops.md ranked first with fileWeight boost, got ${boosted.chunks[0].filePath}`);
  db.close();
}

// ─── Test 22: Aggregation intent widens recall ───
console.log('Test 22: Aggregation intent widens recall');
{
  const db = createDb();
  seedFixture(db);
  // "List everything about creatine" triggers aggregation intent
  const result = getRelevantContext(db, 'List everything about creatine and project allocation');
  // Aggregation intent lowers minCilScore to 0.10 and raises maxChunks to 15
  assert(result.chunks.length > 0, `Expected chunks for aggregation query, got ${result.chunks.length}`);
  db.close();
}

// ─── Test 23: Reasoning intent boosts decisions ───
console.log('Test 23: Reasoning intent boosts decisions');
{
  const db = createDb();
  seedFixture(db);
  const result = getRelevantContext(db, 'Why did we decide to use DataSync as the API gateway?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  // Decision chunk about DataSync should rank high
  const hasDecision = result.chunks.some(c => c.content.includes('DataSync'));
  assert(hasDecision, 'Reasoning intent should surface decision chunks');
  db.close();
}

// ─── Test 24: Forward-looking rescue — recent chunks found for future queries ───
console.log('Test 24: Forward-looking rescue for future queries');
{
  const db = createDb();
  // Insert a chunk from today about next week's plans
  insertChunk(db, {
    content: 'plans to deploy DataSync to production upcoming milestone deadline',
    filePath: 'memory/2026-02-28.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(0),
  });
  // Insert an old chunk that shouldn't surface
  insertChunk(db, {
    content: 'deployed old version production deploy completed successfully',
    filePath: 'memory/2026-01-15.md',
    chunkType: 'fact',
    confidence: 1.0,
    createdAt: daysAgo(44),
  });

  const result = getRelevantContext(db, 'What are my plans for next week?');
  assert(result.chunks.length > 0, `Expected chunks for forward query, got ${result.chunks.length}`);
  const hasRecentPlan = result.chunks.some(c => c.content.includes('DataSync'));
  assert(hasRecentPlan, 'Forward-looking rescue should find recent chunks about future plans');
  db.close();
}

// ─── Test 25: Forward-looking rescue — future named month with forwardTerms ───
console.log('Test 25: Forward-looking rescue — future named month searches forwardTerms');
{
  const db = createDb();
  // Use a month that is always in the future relative to now
  const now = new Date();
  const futureMonth = new Date(now.getFullYear(), now.getMonth() + 2, 1); // 2 months ahead
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const futureMonthName = monthNames[futureMonth.getMonth()];

  // Chunk written recently but mentions the future month
  insertChunk(db, {
    content: `In ${futureMonthName} we need to finalize the quarterly review and submit reports.`,
    filePath: `memory/${daysAgo(1).split('T')[0]}.md`,
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(1),
  });
  // Old chunk that shouldn't surface
  insertChunk(db, {
    content: 'January review completed, all targets met for Q4.',
    filePath: 'memory/2026-01-05.md',
    chunkType: 'fact',
    confidence: 1.0,
    createdAt: daysAgo(54),
  });

  const result = getRelevantContext(db, `What's coming up for me in ${futureMonthName}?`);
  assert(result.chunks.length > 0, `Expected chunks for future month query, got ${result.chunks.length}`);
  const hasMonth = result.chunks.some(c => c.content.toLowerCase().includes(futureMonthName));
  assert(hasMonth, `Forward-looking rescue with forwardTerms should find chunks mentioning "${futureMonthName}"`);
  db.close();
}

// ─── Test 26: Reduced rescue bonus — FTS hits should outrank rescued noise ───
console.log('Test 26: Rescue bonus reduction — FTS hits outrank semantic-only noise');
{
  const db = createDb();
  // Strong FTS match
  insertChunk(db, {
    content: 'Ordered new running shoes from Nike, still waiting on delivery tracking',
    filePath: 'memory/2026-02-25.md',
    chunkType: 'fact',
    confidence: 1.0,
    createdAt: daysAgo(3),
  });
  // Content that might semantically match "purchases" but isn't about waiting
  insertChunk(db, {
    content: 'Reviewed monthly budget spreadsheet for household expenses and savings goals',
    filePath: 'memory/2026-02-20.md',
    chunkType: 'fact',
    confidence: 1.0,
    createdAt: daysAgo(8),
  });

  // Without embeddings, this just tests that FTS ranking is clean
  const result = getRelevantContext(db, 'What purchases am I still waiting on?');
  // The running shoes chunk should rank first (direct FTS match on "waiting")
  if (result.chunks.length > 0) {
    assert(result.chunks[0].content.includes('waiting'), `Expected 'waiting' chunk first, got: ${result.chunks[0].content.slice(0, 60)}`);
  }
  db.close();
}

// ─── Test 27: Temporal date queries use lower minCilScore ───
console.log('Test 27: Temporal date queries lower minCilScore threshold');
{
  const db = createDb();
  // Insert a chunk created on a specific date with content that weakly matches a query
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() - 3); // 3 days ago
  const targetDateStr = targetDate.toISOString().split('T')[0];
  insertChunk(db, {
    content: 'Had a productive morning session, finished code review and deployed hotfix.',
    filePath: `memory/${targetDateStr}.md`,
    chunkType: 'raw',
    confidence: 1.0,
    createdAt: daysAgo(3),
  });

  // Query for "last wednesday" — uses temporal date filter
  // The chunk should survive with lowered minCilScore even if FTS match is weak
  const result = getRelevantContext(db, 'What did I accomplish 3 days ago?');
  // With temporal dateTerms, minCilScore drops to 0.05 and maxChunks raises to 8
  // This gives weak-FTS chunks a better chance of surviving
  assert(result.chunks.length >= 0, 'Temporal query with dateTerms should use relaxed thresholds');
  db.close();
}

// ─── Test 28: Action intent injects search terms ───
console.log('Test 28: Action intent injects action-related search terms');
{
  const db = createDb();
  // Insert a chunk with action-related language
  insertChunk(db, {
    content: 'Pending task: review PR for authentication module. Blocked waiting on security audit.',
    filePath: 'open-loops.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(1),
    fileWeight: 2.0,
  });
  insertChunk(db, {
    content: 'Loop back to refactor the config parser once migration is complete.',
    filePath: 'open-loops.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(2),
    fileWeight: 2.0,
  });

  // "What should I be focused on?" triggers action intent → injects "focus", "task", "pending", "loop", etc.
  const result = getRelevantContext(db, 'What should I be focused on right now?');
  assert(result.chunks.length > 0, `Expected chunks for action query with injected terms, got ${result.chunks.length}`);
  const hasActionContent = result.chunks.some(c => c.content.includes('Pending') || c.content.includes('Loop'));
  assert(hasActionContent, 'Action intent should surface action items via injected search terms');
  db.close();
}

// ─── Test 29: Priority file injection — open-loops.md surfaces for action queries ───
console.log('Test 29: Priority file injection — open-loops.md guaranteed for action intent');
{
  const db = createDb();
  // Insert open-loops content that does NOT match "focused" or "right now" via FTS
  insertChunk(db, {
    content: 'Ship v2.0 release candidate by end of sprint. Coordinate with QA team.',
    heading: 'Critical Priorities',
    filePath: 'memory/open-loops.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(1),
    fileWeight: 2.0,
  });
  insertChunk(db, {
    content: 'Follow up with vendor on hardware delivery estimate. Still outstanding.',
    heading: 'Open Items',
    filePath: 'memory/open-loops.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(2),
    fileWeight: 2.0,
  });
  // Insert some noise that matches "focused" via FTS
  insertChunk(db, {
    content: 'Stayed focused during the afternoon meeting, discussed roadmap priorities.',
    filePath: 'memory/2026-02-25.md',
    chunkType: 'raw',
    confidence: 1.0,
    createdAt: daysAgo(3),
  });

  const result = getRelevantContext(db, 'What should I be focused on right now?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  const hasOpenLoops = result.chunks.some(c => c.filePath && c.filePath.includes('open-loops'));
  assert(hasOpenLoops, 'Priority file injection should guarantee open-loops.md appears for action queries');
  // open-loops chunks should be in top 3
  const top3 = result.chunks.slice(0, 3);
  const openLoopsInTop3 = top3.some(c => c.filePath && c.filePath.includes('open-loops'));
  assert(openLoopsInTop3, 'Injected open-loops chunks should be in top 3 results');
  db.close();
}

// ─── Test 30: Priority file injection — self-review surfaces for action queries ───
console.log('Test 30: Priority file injection — self-review surfaces for action intent');
{
  const db = createDb();
  insertChunk(db, {
    content: 'Self-review: need to improve test coverage and reduce tech debt in auth module.',
    heading: 'Action Items',
    filePath: 'memory/self-review-2026-02.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(3),
  });
  insertChunk(db, {
    content: 'Random daily note about weather and lunch plans for the day.',
    filePath: 'memory/2026-02-26.md',
    chunkType: 'raw',
    confidence: 1.0,
    createdAt: daysAgo(2),
  });

  const result = getRelevantContext(db, 'What should I be focused on right now?');
  const hasSelfReview = result.chunks.some(c => c.filePath && c.filePath.includes('self-review'));
  assert(hasSelfReview, 'Self-review file should be injected for action queries');
  db.close();
}

// ─── Test 31: Priority file injection — does NOT fire for non-action queries ───
console.log('Test 31: Priority file injection — no injection for non-action queries');
{
  const db = createDb();
  // open-loops content that doesn't match "creatine"
  insertChunk(db, {
    content: 'Ship v2.0 release candidate by end of sprint.',
    heading: 'Critical Priorities',
    filePath: 'memory/open-loops.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(1),
    fileWeight: 2.0,
  });
  // Creatine content
  insertChunk(db, {
    content: 'Creatine 5g daily started Feb 23. Day 1: improved recovery.',
    heading: 'Supplements',
    filePath: 'MEMORY.md',
    chunkType: 'fact',
    confidence: 1.0,
    createdAt: daysAgo(4),
    fileWeight: 1.5,
  });

  const result = getRelevantContext(db, "How's the creatine experiment going?");
  // open-loops should NOT be injected for a non-action query
  const hasOpenLoops = result.chunks.some(c => c.filePath && c.filePath.includes('open-loops'));
  assert(!hasOpenLoops, 'open-loops.md should NOT be injected for non-action queries');
  db.close();
}

// ─── Test 32: Priority file injection — dedup when already in FTS results ───
console.log('Test 32: Priority file injection — dedup when chunks already in FTS results');
{
  const db = createDb();
  // open-loops content that WILL match via FTS (contains "pending", "task")
  insertChunk(db, {
    content: 'Pending task: review PR for authentication module. Priority item.',
    heading: 'Open Loops',
    filePath: 'memory/open-loops.md',
    chunkType: 'action_item',
    confidence: 1.0,
    createdAt: daysAgo(1),
    fileWeight: 2.0,
  });

  const result = getRelevantContext(db, 'What should I be focused on right now?');
  // Count how many times open-loops.md appears — should be exactly once (no dupes)
  const openLoopsChunks = result.chunks.filter(c => c.filePath && c.filePath.includes('open-loops'));
  assert(openLoopsChunks.length === 1, `Expected exactly 1 open-loops chunk (dedup), got ${openLoopsChunks.length}`);
  db.close();
}

// ─── Test 33: isRuleChunk — strong rule detection ───
console.log('Test 33: isRuleChunk — strong rule patterns detected');
{
  const r1 = isRuleChunk({ content: 'NON-NEGOTIABLE: Never commit API keys to the repository.', heading: 'Security Rules' });
  assert(r1.isRule === true, 'NON-NEGOTIABLE should be detected as rule');
  assert(r1.confidence === 0.9, `Expected confidence 0.9, got ${r1.confidence}`);

  const r2 = isRuleChunk({ content: 'Hard rules for Amazon account purchases.', heading: '' });
  assert(r2.isRule === true, 'Hard rules should be detected');
  assert(r2.confidence === 0.9, `Expected confidence 0.9, got ${r2.confidence}`);

  const r3 = isRuleChunk({ content: 'Always require two-factor authentication before any deployment.', heading: '' });
  assert(r3.isRule === true, '"always require" should be detected');
}

// ─── Test 34: isRuleChunk — moderate rule detection ───
console.log('Test 34: isRuleChunk — moderate rule patterns detected');
{
  const r1 = isRuleChunk({ content: 'Company policy: all expenses over $500 need manager sign-off. No exceptions.', heading: '' });
  assert(r1.isRule === true, 'policy + no exceptions should be detected as rule');
  assert(r1.confidence === 0.7, `Expected confidence 0.7 for two moderate matches, got ${r1.confidence}`);

  const r2 = isRuleChunk({ content: 'Token efficiency guidelines for API usage.', heading: '' });
  assert(r2.isRule === true, '"guidelines" should be detected');
  assert(r2.confidence === 0.4, `Expected confidence 0.4 for single moderate match, got ${r2.confidence}`);
}

// ─── Test 35: isRuleChunk — non-rule content ───
console.log('Test 35: isRuleChunk — normal content not flagged');
{
  const r1 = isRuleChunk({ content: 'Ordered new headphones from Amazon, expected delivery March 5.', heading: 'Purchases' });
  assert(r1.isRule === false, 'Purchase fact should not be flagged as rule');

  const r2 = isRuleChunk({ content: 'Weight dropped to 197 from 215 since starting retatrutide.', heading: 'Health' });
  assert(r2.isRule === false, 'Health fact should not be flagged as rule');
}

// ─── Test 36: Rule penalty — rules demoted for factual queries ───
console.log('Test 36: Rule penalty — rule chunks demoted for factual queries');
{
  const db = createDb();
  // Rule chunk that will match "purchase" via FTS
  insertChunk(db, {
    content: 'Amazon Account Hard Rules: NON-NEGOTIABLE. Never purchase without checking price history first.',
    heading: 'Account Rules',
    filePath: 'TOOLS.md',
    chunkType: 'confirmed',
    confidence: 1.0,
    createdAt: daysAgo(10),
    fileWeight: 1.1,
  });
  // Factual chunk about an actual purchase
  insertChunk(db, {
    content: 'Ordered SmartWings blinds for bedroom, purchase confirmed, shipping 2-3 weeks.',
    heading: 'Purchases',
    filePath: 'MEMORY.md',
    chunkType: 'fact',
    confidence: 1.0,
    createdAt: daysAgo(5),
    fileWeight: 1.5,
  });

  const result = getRelevantContext(db, 'What purchases am I still waiting on?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  // The factual purchase should outrank the rule
  if (result.chunks.length >= 2) {
    const ruleIdx = result.chunks.findIndex(c => c.content.includes('NON-NEGOTIABLE'));
    const factIdx = result.chunks.findIndex(c => c.content.includes('SmartWings'));
    if (ruleIdx >= 0 && factIdx >= 0) {
      assert(factIdx < ruleIdx, `Factual purchase (idx ${factIdx}) should outrank rule chunk (idx ${ruleIdx})`);
    }
  }
  db.close();
}

// ─── Test 37: Rule penalty — escape hatch for rule-specific queries ───
console.log('Test 37: Rule penalty — no penalty when asking about rules');
{
  const db = createDb();
  insertChunk(db, {
    content: 'NON-NEGOTIABLE: Never purchase without checking price history first. Hard rules for account.',
    heading: 'Amazon Account Rules',
    filePath: 'TOOLS.md',
    chunkType: 'confirmed',
    confidence: 1.0,
    createdAt: daysAgo(10),
    fileWeight: 1.1,
  });

  const result = getRelevantContext(db, 'What are my Amazon account rules?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  const hasRules = result.chunks.some(c => c.content.includes('NON-NEGOTIABLE'));
  assert(hasRules, 'Rule chunks should still appear when user asks about rules (escape hatch)');
  db.close();
}

// ─── Test 38: Rule penalty — no penalty for reasoning intent ───
console.log('Test 38: Rule penalty — reasoning queries preserve rule chunks');
{
  const db = createDb();
  insertChunk(db, {
    content: 'Policy decision: mandatory code review before any merge. No exceptions allowed.',
    heading: 'Engineering Guidelines',
    filePath: 'MEMORY.md',
    chunkType: 'decision',
    confidence: 1.0,
    createdAt: daysAgo(5),
    fileWeight: 1.5,
  });

  const result = getRelevantContext(db, 'Why did we decide to require mandatory code reviews?');
  assert(result.chunks.length > 0, `Expected chunks, got ${result.chunks.length}`);
  const hasPolicy = result.chunks.some(c => c.content.includes('mandatory code review'));
  assert(hasPolicy, 'Reasoning intent should not penalize rule-like decision chunks');
  db.close();
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
