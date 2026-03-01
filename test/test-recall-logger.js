#!/usr/bin/env node
/**
 * Tests for recall-logger.js — JSONL logging, summarization, rotation.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logRecall, summarizeLog, rotateLog } = require('../lib/recall-logger');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmpWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-logger-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  return ws;
}

// ─── Test 1: logRecall writes JSONL entries ───
console.log('Test 1: logRecall writes JSONL entries');
{
  const ws = tmpWorkspace();
  logRecall(ws, {
    query: 'test query about creatine',
    queryTerms: ['creatine'],
    chunksReturned: 3,
    chunksDropped: 2,
    excludedByPattern: 1,
    tokenEstimate: 450,
    chunks: [
      { filePath: 'MEMORY.md', cilScore: 0.8523, chunkType: 'fact', content: 'Creatine 5g daily morning protocol' },
    ],
    durationMs: 12,
  });
  logRecall(ws, {
    query: 'second query',
    queryTerms: ['second'],
    chunksReturned: 0,
    chunksDropped: 5,
    excludedByPattern: 3,
    tokenEstimate: 0,
    chunks: [],
    durationMs: 8,
  });

  const logPath = path.join(ws, '.memory', 'recall-log.jsonl');
  assert(fs.existsSync(logPath), 'Log file should exist');

  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
  assert(lines.length === 2, `Expected 2 lines, got ${lines.length}`);

  const entry1 = JSON.parse(lines[0]);
  assert(entry1.query === 'test query about creatine', `Expected query text, got: ${entry1.query}`);
  assert(entry1.returned === 3, `Expected returned=3, got ${entry1.returned}`);
  assert(entry1.excluded === 1, `Expected excluded=1, got ${entry1.excluded}`);
  assert(entry1.tokens === 450, `Expected tokens=450, got ${entry1.tokens}`);
  assert(entry1.chunks.length === 1, `Expected 1 chunk entry, got ${entry1.chunks.length}`);
  assert(entry1.chunks[0].file === 'MEMORY.md', `Expected MEMORY.md, got ${entry1.chunks[0].file}`);
  assert(entry1.chunks[0].score === 0.8523, `Expected score 0.8523, got ${entry1.chunks[0].score}`);
  assert(typeof entry1.ts === 'string', 'Expected timestamp');
  assert(entry1.durationMs === 12, `Expected durationMs=12, got ${entry1.durationMs}`);

  const entry2 = JSON.parse(lines[1]);
  assert(entry2.returned === 0, 'Second entry should have 0 returned');
  assert(entry2.excluded === 3, `Expected excluded=3, got ${entry2.excluded}`);

  fs.rmSync(ws, { recursive: true });
}

// ─── Test 2: logRecall truncates long queries ───
console.log('Test 2: logRecall truncates long queries');
{
  const ws = tmpWorkspace();
  const longQuery = 'x'.repeat(500);
  logRecall(ws, { query: longQuery, queryTerms: [], chunksReturned: 0, chunksDropped: 0, tokenEstimate: 0, chunks: [], durationMs: 0 });

  const logPath = path.join(ws, '.memory', 'recall-log.jsonl');
  const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
  assert(entry.query.length === 200, `Expected truncated to 200, got ${entry.query.length}`);

  fs.rmSync(ws, { recursive: true });
}

// ─── Test 3: logRecall handles missing .memory dir gracefully ───
console.log('Test 3: logRecall handles missing .memory dir gracefully');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-logger-nodir-'));
  // No .memory dir — should not throw
  let threw = false;
  try {
    logRecall(ws, { query: 'test', queryTerms: [], chunksReturned: 0, chunksDropped: 0, tokenEstimate: 0, chunks: [], durationMs: 0 });
  } catch (_) { threw = true; }
  assert(!threw, 'logRecall should not throw on missing dir');
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 4: summarizeLog computes stats ───
console.log('Test 4: summarizeLog computes stats');
{
  const ws = tmpWorkspace();
  // Write 5 entries
  for (let i = 0; i < 5; i++) {
    logRecall(ws, {
      query: `query ${i}`,
      queryTerms: ['test'],
      chunksReturned: i === 0 ? 0 : 3,
      chunksDropped: 2,
      excludedByPattern: 1,
      tokenEstimate: i === 0 ? 0 : 300,
      chunks: i === 0 ? [] : [
        { filePath: 'MEMORY.md', cilScore: 0.75, chunkType: 'fact', content: 'test content' },
        { filePath: 'memory/2026-02-20.md', cilScore: 0.65, chunkType: 'raw', content: 'other content' },
        { filePath: 'MEMORY.md', cilScore: 0.55, chunkType: 'confirmed', content: 'third' },
      ],
      durationMs: 10 + i,
    });
  }

  const stats = summarizeLog(ws);
  assert(stats.total === 5, `Expected total=5, got ${stats.total}`);
  assert(stats.emptyRecalls === 1, `Expected 1 empty recall, got ${stats.emptyRecalls}`);
  assert(stats.emptyRate === '20.0%', `Expected 20.0%, got ${stats.emptyRate}`);
  assert(stats.avgChunks > 0, `Expected avgChunks > 0, got ${stats.avgChunks}`);
  assert(stats.avgTokens > 0, `Expected avgTokens > 0, got ${stats.avgTokens}`);
  assert(stats.avgDurationMs > 0, `Expected avgDurationMs > 0, got ${stats.avgDurationMs}`);
  assert(stats.totalExcludedByPattern === 5, `Expected 5 total excluded, got ${stats.totalExcludedByPattern}`);
  assert(stats.topFiles.length > 0, 'Expected top files');
  assert(stats.topFiles[0][0] === 'MEMORY.md', `Expected MEMORY.md as top file, got ${stats.topFiles[0][0]}`);
  assert(stats.scoreDistribution.avg > 0, 'Expected avg score > 0');
  assert(stats.scoreDistribution.min <= stats.scoreDistribution.max, 'Min should be <= max');

  fs.rmSync(ws, { recursive: true });
}

// ─── Test 5: summarizeLog respects 'last' parameter ───
console.log('Test 5: summarizeLog respects last parameter');
{
  const ws = tmpWorkspace();
  for (let i = 0; i < 10; i++) {
    logRecall(ws, { query: `q${i}`, queryTerms: [], chunksReturned: i, chunksDropped: 0, tokenEstimate: 0, chunks: [], durationMs: 0 });
  }

  const last3 = summarizeLog(ws, { last: 3 });
  assert(last3.total === 3, `Expected 3 entries, got ${last3.total}`);
  // Last 3 entries have returned = 7, 8, 9 → avg = 8.0
  assert(last3.avgChunks === 8, `Expected avgChunks=8, got ${last3.avgChunks}`);

  fs.rmSync(ws, { recursive: true });
}

// ─── Test 6: summarizeLog on missing log ───
console.log('Test 6: summarizeLog on missing log');
{
  const ws = tmpWorkspace();
  const stats = summarizeLog(ws);
  assert(stats.error === 'No recall log found', `Expected error message, got: ${JSON.stringify(stats)}`);
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 7: rotateLog trims when over maxLines ───
console.log('Test 7: rotateLog trims when over maxLines');
{
  const ws = tmpWorkspace();
  // Write 20 lines
  const logPath = path.join(ws, '.memory', 'recall-log.jsonl');
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ ts: new Date().toISOString(), query: `q${i}`, returned: i }));
  }
  fs.writeFileSync(logPath, lines.join('\n') + '\n');

  // Rotate with maxLines=15, keepLines=10
  const result = rotateLog(ws, { maxLines: 15, keepLines: 10 });
  assert(result.rotated === true, `Expected rotated=true, got ${result.rotated}`);
  assert(result.before === 20, `Expected before=20, got ${result.before}`);
  assert(result.after === 10, `Expected after=10, got ${result.after}`);

  // Verify file was trimmed and kept the LAST 10
  const remaining = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
  assert(remaining.length === 10, `Expected 10 remaining lines, got ${remaining.length}`);
  const first = JSON.parse(remaining[0]);
  assert(first.query === 'q10', `Expected first kept entry to be q10, got ${first.query}`);

  fs.rmSync(ws, { recursive: true });
}

// ─── Test 8: rotateLog no-op when under maxLines ───
console.log('Test 8: rotateLog no-op when under maxLines');
{
  const ws = tmpWorkspace();
  const logPath = path.join(ws, '.memory', 'recall-log.jsonl');
  fs.writeFileSync(logPath, '{"ts":"2026-02-28","query":"test"}\n');

  const result = rotateLog(ws, { maxLines: 100 });
  assert(result.rotated === false, `Expected rotated=false, got ${result.rotated}`);
  assert(result.lines === 1, `Expected lines=1, got ${result.lines}`);

  fs.rmSync(ws, { recursive: true });
}

// ─── Test 9: rotateLog on missing file ───
console.log('Test 9: rotateLog on missing file');
{
  const ws = tmpWorkspace();
  const result = rotateLog(ws);
  assert(result.error === 'No log file', `Expected error, got: ${JSON.stringify(result)}`);
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 10: CIL pipeline logs automatically ───
console.log('Test 10: CIL pipeline logs automatically');
{
  const Database = require('better-sqlite3');
  const { SCHEMA } = require('../lib/store');
  const { getRelevantContext } = require('../lib/context');

  const ws = tmpWorkspace();
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE chunks ADD COLUMN file_weight REAL DEFAULT 1.0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN last_accessed TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN stale INTEGER DEFAULT 0'); } catch (_) {}

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, stale)
    VALUES (?, ?, ?, 1, 10, '[]', 'fact', 1.0, ?, ?, 1.0, 0)`).run('test.md', 'Protocol', 'bromantane dopamine supplement daily', now, now);

  getRelevantContext(db, 'bromantane protocol', { workspace: ws });

  const logPath = path.join(ws, '.memory', 'recall-log.jsonl');
  assert(fs.existsSync(logPath), 'CIL should auto-create recall log');

  const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
  assert(entry.query === 'bromantane protocol', `Expected query in log, got: ${entry.query}`);
  assert(entry.returned > 0, `Expected returned > 0, got ${entry.returned}`);
  assert(entry.durationMs >= 0, 'Expected durationMs >= 0');
  assert(Array.isArray(entry.terms), 'Expected terms array');
  assert(entry.terms.includes('bromantane'), 'Expected bromantane in terms');

  db.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
