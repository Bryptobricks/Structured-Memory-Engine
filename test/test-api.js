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

async function main() {

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
  assert(typeof engine.embedAll === 'function', 'Expected embedAll method');
  assert(typeof engine.embeddingStatus === 'function', 'Expected embeddingStatus method');
  assert(typeof engine.warmup === 'function', 'Expected warmup method');
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
  const result = await engine.remember('Test fact for API', { tag: 'fact', date: '2026-02-20' });
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
  await engine.remember('Creatine 5g daily morning protocol', { tag: 'confirmed', date: '2026-02-20' });
  const results = engine.query('creatine');
  assert(Array.isArray(results), 'Expected array of results');
  assert(results.length > 0, `Expected results, got ${results.length}`);
  assert(results[0].content.includes('Creatine'), 'Expected content to include Creatine');
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
  await engine.remember('Sleep 8 hours minimum', { tag: 'confirmed', date: '2026-02-20' });
  await engine.remember('Maybe try melatonin', { tag: 'opinion', date: '2026-02-20' });
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
  await engine.remember('Test memory for indexing', { date: '2026-02-20' });
  const result = await engine.index({ force: true });
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
  const result = await engine.reflect({ dryRun: true });
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

// ─── Test 13: api.context() respects excludeFromRecall from config ───
console.log('Test 13: api.context() respects excludeFromRecall from config');
{
  const ws = tmpWorkspace();
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.memory', 'config.json'), JSON.stringify({
    excludeFromRecall: ['CLAUDE.md'],
  }));
  const engine = create({ workspace: ws });
  // Write a memory file that will be indexed
  fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'memory', '2026-02-20.md'), '# Notes\n- [fact] creatine protocol daily morning supplement\n');
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# System\n- creatine protocol instructions for daily supplement\n');
  await engine.index({ force: true });
  const result = await engine.context('creatine supplement');
  const hasClaude = result.chunks.some(c => c.filePath === 'CLAUDE.md');
  assert(!hasClaude, 'context() should exclude CLAUDE.md per config excludeFromRecall');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 14: api.query() respects excludeFromRecall from config ───
console.log('Test 14: api.query() respects excludeFromRecall from config');
{
  const ws = tmpWorkspace();
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.memory', 'config.json'), JSON.stringify({
    excludeFromRecall: ['CLAUDE.md'],
  }));
  const engine = create({ workspace: ws });
  fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'memory', '2026-02-20.md'), '# Notes\n- [fact] creatine protocol daily morning supplement\n');
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# System\n- creatine protocol instructions for daily supplement\n');
  await engine.index({ force: true });
  const results = engine.query('creatine');
  const hasClaude = results.some(r => r.filePath === 'CLAUDE.md');
  assert(!hasClaude, 'query() should exclude CLAUDE.md per config excludeFromRecall');
  const hasMemory = results.some(r => r.filePath.includes('memory/'));
  assert(hasMemory, 'query() should still return non-excluded files');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 15: context() is async and returns context object ───
console.log('Test 15: context() is async and returns context object');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  await engine.remember('Magnesium glycinate 400mg for sleep quality improvement', { tag: 'confirmed', date: '2026-02-20' });
  const result = await engine.context('magnesium sleep');
  assert(typeof result === 'object', 'Expected object from context()');
  assert(typeof result.text === 'string', 'Expected text field');
  assert(Array.isArray(result.chunks), 'Expected chunks array');
  assert(typeof result.tokenEstimate === 'number', 'Expected tokenEstimate');
  if (result.chunks.length > 0) {
    assert(result.chunks[0].content.includes('Magnesium'), 'Expected chunk content to include Magnesium');
  }
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 16: embeddingStatus() returns status without embeddings dep ───
console.log('Test 16: embeddingStatus() returns status');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  await engine.remember('Test chunk for embedding status', { date: '2026-02-20' });
  const status = engine.embeddingStatus();
  assert(typeof status === 'object', 'Expected object');
  assert(typeof status.total === 'number', 'Expected total count');
  assert(typeof status.embedded === 'number', 'Expected embedded count');
  assert(typeof status.pending === 'number', 'Expected pending count');
  assert(typeof status.available === 'boolean', 'Expected available boolean');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 17: embedAll() graceful when dep not available ───
console.log('Test 17: embedAll() graceful when dep not available');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  const result = await engine.embedAll();
  // If @xenova/transformers isn't installed, should return graceful error
  assert(typeof result === 'object', 'Expected object from embedAll()');
  assert(typeof result.embedded === 'number', 'Expected embedded count');
  assert(typeof result.total === 'number', 'Expected total count');
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

// ─── Test 18: remember/index/reflect return promises ───
console.log('Test 18: async methods return promises');
{
  const ws = tmpWorkspace();
  const engine = create({ workspace: ws });
  const rememberResult = engine.remember('Async test', { tag: 'fact', date: '2026-02-20' });
  assert(rememberResult instanceof Promise, 'remember() should return a Promise');
  await rememberResult;
  const indexResult = engine.index();
  assert(indexResult instanceof Promise, 'index() should return a Promise');
  await indexResult;
  const reflectResult = engine.reflect({ dryRun: true });
  assert(reflectResult instanceof Promise, 'reflect() should return a Promise');
  await reflectResult;
  const contextResult = engine.context('test');
  assert(contextResult instanceof Promise, 'context() should return a Promise');
  await contextResult;
  engine.close();
  fs.rmSync(ws, { recursive: true });
}

}

main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
