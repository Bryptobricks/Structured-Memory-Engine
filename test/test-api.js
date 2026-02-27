#!/usr/bin/env node
/**
 * Tests for the Node.js API — public surface of structured-memory-engine.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { create } = require('../lib/api');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sme-api-test-'));
}

// ─── Test 1: create() returns all methods ───
console.log('Test 1: create() returns all methods');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  assert(typeof engine.query === 'function', 'Expected query method');
  assert(typeof engine.remember === 'function', 'Expected remember method');
  assert(typeof engine.index === 'function', 'Expected index method');
  assert(typeof engine.reflect === 'function', 'Expected reflect method');
  assert(typeof engine.status === 'function', 'Expected status method');
  assert(typeof engine.restore === 'function', 'Expected restore method');
  assert(typeof engine.close === 'function', 'Expected close method');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 2: create() initializes .memory/ directory ───
console.log('Test 2: create() initializes .memory/ directory');
{
  const ws = tmpWorkspace();
  assert(!fs.existsSync(path.join(ws, '.memory')), '.memory/ should not exist yet');
  const engine = create({ workspace: ws });
  assert(fs.existsSync(path.join(ws, '.memory')), '.memory/ should have been created');
  assert(fs.existsSync(path.join(ws, '.memory', 'index.sqlite')), 'index.sqlite should exist');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 3: status() returns raw stats object ───
console.log('Test 3: status() returns raw stats object');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  const stats = engine.status();
  assert(typeof stats === 'object', 'Expected object');
  assert(typeof stats.fileCount === 'number', `Expected fileCount number, got ${typeof stats.fileCount}`);
  assert(typeof stats.chunkCount === 'number', `Expected chunkCount number, got ${typeof stats.chunkCount}`);
  assert(Array.isArray(stats.files), 'Expected files array');
  assert(stats.content === undefined, 'Should NOT have MCP content wrapper');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 4: remember() writes and returns raw result ───
console.log('Test 4: remember() writes and returns raw result');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  const result = engine.remember('Test fact for API', { tag: 'fact', date: '2026-02-20' });
  assert(result.filePath.endsWith('2026-02-20.md'), `Expected dated file, got ${result.filePath}`);
  assert(result.created === true, 'Expected created=true');
  assert(result.line === '- [fact] Test fact for API', `Expected tagged line, got ${result.line}`);
  assert(result.content === undefined, 'Should NOT have MCP content wrapper');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 5: remember() + query() roundtrip ───
console.log('Test 5: remember() + query() roundtrip');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  engine.remember('Bromantane 50mg sublingual morning protocol', { tag: 'confirmed', date: '2026-02-20' });
  const results = engine.query('bromantane');
  assert(Array.isArray(results), 'Expected array of results');
  assert(results.length > 0, `Expected results, got ${results.length}`);
  assert(results[0].content.includes('Bromantane'), 'Expected content to include Bromantane');
  assert(typeof results[0].finalScore === 'number', 'Expected finalScore');
  assert(typeof results[0].filePath === 'string', 'Expected filePath string');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 6: query() returns empty array for no matches ───
console.log('Test 6: query() returns empty array for no matches');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  const results = engine.query('xyzzy-nonexistent-term-12345');
  assert(Array.isArray(results), 'Expected array');
  assert(results.length === 0, `Expected 0 results, got ${results.length}`);
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 7: query() accepts type filter ───
console.log('Test 7: query() accepts type filter');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  engine.remember('Sleep 8 hours minimum', { tag: 'confirmed', date: '2026-02-20' });
  engine.remember('Maybe try melatonin', { tag: 'opinion', date: '2026-02-20' });
  const all = engine.query('sleep melatonin');
  const confirmed = engine.query('sleep melatonin', { type: 'confirmed' });
  assert(all.length >= confirmed.length, 'Filtered results should be <= all results');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 8: index() returns counts ───
console.log('Test 8: index() returns counts');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  engine.remember('Test memory for indexing', { date: '2026-02-20' });
  const result = engine.index({ force: true });
  assert(typeof result === 'object', 'Expected object');
  assert(typeof result.indexed === 'number', 'Expected indexed count');
  assert(typeof result.skipped === 'number', 'Expected skipped count');
  assert(typeof result.total === 'number', 'Expected total count');
  assert(result.indexed > 0, `Expected >0 indexed, got ${result.indexed}`);
  assert(result.content === undefined, 'Should NOT have MCP content wrapper');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 9: reflect() returns cycle results ───
console.log('Test 9: reflect() returns cycle results');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  const result = engine.reflect({ dryRun: true });
  assert(typeof result.decay === 'object', 'Expected decay object');
  assert(typeof result.reinforce === 'object', 'Expected reinforce object');
  assert(typeof result.stale === 'object', 'Expected stale object');
  assert(typeof result.contradictions === 'object', 'Expected contradictions object');
  assert(typeof result.prune === 'object', 'Expected prune object');
  assert(typeof result.decay.decayed === 'number', 'Expected decay.decayed count');
  assert(result.content === undefined, 'Should NOT have MCP content wrapper');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 10: restore() on missing chunk ───
console.log('Test 10: restore() on missing chunk');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  const result = engine.restore(99999);
  assert(result.restored === false, 'Expected restored=false for missing chunk');
  assert(typeof result.error === 'string', 'Expected error message');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 11: close() prevents further operations ───
console.log('Test 11: close() prevents further operations');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  engine.close();
  let threw = false;
  try { engine.status(); } catch (_) { threw = true; }
  assert(threw, 'Expected error after close');
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 12: Double close() does not crash ───
console.log('Test 12: Double close() does not crash');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  engine.close();
  let threw = false;
  try { engine.close(); } catch (_) { threw = true; }
  assert(!threw, 'Double close should not throw');
  fs.rmSync(ws, { recursive: true });
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
