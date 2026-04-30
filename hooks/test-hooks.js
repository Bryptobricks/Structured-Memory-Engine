#!/usr/bin/env node
/**
 * test-hooks.js
 * Simple tests for compaction-logger and tool-result-compressor.
 * No external test framework required — runs with plain node.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── test harness ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertEq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.error(`    expected: ${JSON.stringify(b)}\n    got:      ${JSON.stringify(a)}`);
  assert(ok, label);
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ─── load hooks ──────────────────────────────────────────────────────────────
const {
  compactionLogger,
  formatEntry,
  parseEntries,
  serializeEntries,
  MAX_ENTRIES,
} = require('./compaction-logger');

const {
  toolResultCompressor,
  cleanText,
  MAX_LENGTH,
} = require('./tool-result-compressor');

// ─── compaction-logger tests ─────────────────────────────────────────────────
section('compaction-logger: formatEntry');

{
  const entry = formatEntry({ messagesCompacted: 12, tokensBefore: 5000, tokensAfter: 1200, summaryLength: 800 });
  assert(entry.includes('Messages compacted: 12'), 'includes message count');
  assert(entry.includes('Tokens before: 5000'), 'includes tokens before');
  assert(entry.includes('Tokens after:  1200'), 'includes tokens after');
  assert(entry.includes('Summary length: 800 chars'), 'includes summary length');
  assert(entry.startsWith('## Compaction'), 'starts with heading');
}

section('compaction-logger: parseEntries / serializeEntries round-trip');

{
  const entries = ['## Entry 1\n- x: 1', '## Entry 2\n- x: 2'];
  const serialized = serializeEntries(entries);
  const parsed = parseEntries(serialized);
  assertEq(parsed, entries, 'round-trip preserves entries');
}

{
  assert(parseEntries('').length === 0, 'empty string → empty array');
  assert(parseEntries(null).length === 0, 'null → empty array');
}

section('compaction-logger: writes to temp file');

{
  const tmpFile = path.join(os.tmpdir(), `live-test-${Date.now()}.md`);

  // Write first entry
  compactionLogger({ messagesCompacted: 5, tokensBefore: 1000, tokensAfter: 300, summaryLength: 200 }, { livePath: tmpFile });
  assert(fs.existsSync(tmpFile), 'file created after first write');

  const content1 = fs.readFileSync(tmpFile, 'utf8');
  assert(content1.includes('Messages compacted: 5'), 'first entry written');

  // Write more entries to test rolling window
  for (let i = 0; i < 6; i++) {
    compactionLogger({ messagesCompacted: i, tokensBefore: 100 * i, tokensAfter: 50 * i, summaryLength: 10 * i }, { livePath: tmpFile });
  }

  const finalContent = fs.readFileSync(tmpFile, 'utf8');
  const entries = parseEntries(finalContent);
  assert(entries.length === MAX_ENTRIES, `rolling window capped at ${MAX_ENTRIES}`);

  fs.unlinkSync(tmpFile);
}

section('compaction-logger: graceful fallback on bad path');

{
  // Should not throw even with an invalid path
  let threw = false;
  try {
    compactionLogger({}, { livePath: '/nonexistent/deep/path/LIVE.md' });
  } catch {
    threw = true;
  }
  assert(!threw, 'does not throw on bad path');
}

// ─── tool-result-compressor tests ────────────────────────────────────────────
section('tool-result-compressor: cleanText — ANSI stripping');

{
  const ansi = '\x1b[32mHello\x1b[0m World';
  const { cleaned, changed } = cleanText(ansi);
  assert(!cleaned.includes('\x1b'), 'ANSI codes removed');
  assert(cleaned.includes('Hello'), 'text preserved');
  assert(changed, 'changed flag true');
}

section('tool-result-compressor: cleanText — npm WARN / notice');

{
  const text = 'output\nnpm WARN deprecated foo@1.0.0: use bar\nnpm notice created v1.0.0\nmore output';
  const { cleaned } = cleanText(text);
  assert(!cleaned.includes('npm WARN'), 'npm WARN removed');
  assert(!cleaned.includes('npm notice'), 'npm notice removed');
  assert(cleaned.includes('output'), 'non-warn output preserved');
}

section('tool-result-compressor: cleanText — pip warnings');

{
  const text = 'Installing\nWARNING: legacy-install-failure\nDEPRECATION: old-feature\ndone';
  const { cleaned } = cleanText(text);
  assert(!cleaned.includes('WARNING:'), 'pip WARNING removed');
  assert(!cleaned.includes('DEPRECATION:'), 'pip DEPRECATION removed');
  assert(cleaned.includes('done'), 'non-warning output preserved');
}

section('tool-result-compressor: cleanText — Node ExperimentalWarning');

{
  const text = '(node:12345) [DEP0123] ExperimentalWarning: The fs.promises API is experimental\nresult';
  const { cleaned } = cleanText(text);
  assert(!cleaned.includes('ExperimentalWarning'), 'ExperimentalWarning removed');
  assert(cleaned.includes('result'), 'result preserved');
}

section('tool-result-compressor: cleanText — box-drawing chars');

{
  const text = '┌─────┐\n│ hi  │\n└─────┘';
  const { cleaned } = cleanText(text);
  assert(!/[─│┌┐└┘]/.test(cleaned), 'box chars removed');
  assert(cleaned.includes('hi'), 'text inside box preserved');
}

section('tool-result-compressor: cleanText — excessive blank lines');

{
  const text = 'a\n\n\n\n\nb';
  const { cleaned } = cleanText(text);
  assert(!cleaned.includes('\n\n\n'), '3+ blank lines collapsed');
  assert(cleaned.includes('a') && cleaned.includes('b'), 'content preserved');
}

section('tool-result-compressor: cleanText — truncation');

{
  const long = 'x'.repeat(MAX_LENGTH + 500);
  const { cleaned, changed } = cleanText(long);
  assert(cleaned.length <= MAX_LENGTH + 40, 'truncated to near MAX_LENGTH');
  assert(cleaned.includes('[...truncated'), 'truncation marker present');
  assert(changed, 'changed flag true');
}

section('tool-result-compressor: no-op when clean');

{
  const clean = 'Hello, world!\nNo warnings here.\n';
  const result = toolResultCompressor(clean);
  assert(result === null, 'returns null when no changes needed');
}

section('tool-result-compressor: string input');

{
  const dirty = '\x1b[31mError\x1b[0m occurred';
  const result = toolResultCompressor(dirty);
  assert(result !== null && result !== undefined, 'returns result for dirty string');
  assert(typeof result.message === 'string', 'message is string');
  assert(!result.message.includes('\x1b'), 'ANSI stripped from message');
}

section('tool-result-compressor: array of parts');

{
  const parts = [
    { type: 'text', text: '\x1b[32mok\x1b[0m' },
    { type: 'text', text: 'clean text' },
    { type: 'image_url', url: 'http://example.com/img.png' },
  ];
  const result = toolResultCompressor(parts);
  assert(result !== null && result !== undefined, 'returns result for dirty array');
  assert(Array.isArray(result.message), 'message is array');
  assert(!result.message[0].text.includes('\x1b'), 'ANSI stripped from part[0]');
  assertEq(result.message[1].text, 'clean text', 'clean part[1] unchanged');
  assertEq(result.message[2], parts[2], 'non-text part[2] unchanged');
}

section('tool-result-compressor: wrapped {content} object');

{
  const wrapped = { role: 'tool', content: '\x1b[1mBold\x1b[0m' };
  const result = toolResultCompressor(wrapped);
  assert(result !== null, 'returns result for wrapped dirty content');
  assert(result.message.role === 'tool', 'role preserved');
  assert(!result.message.content.includes('\x1b'), 'ANSI stripped from wrapped content');
}

section('tool-result-compressor: graceful fallback on error');

{
  // Pass something pathological
  let threw = false;
  try {
    const r = toolResultCompressor(undefined);
    // undefined input → should return undefined or null gracefully
    assert(r === undefined || r === null, 'undefined input returns graceful value');
  } catch {
    threw = true;
  }
  assert(!threw, 'does not throw on undefined input');
}

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════`);
console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All tests passed ✓');
}
