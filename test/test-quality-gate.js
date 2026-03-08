#!/usr/bin/env node
/**
 * Tests for quality-gate module.
 */
const { gateCheck } = require('../lib/quality-gate');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// --- Rejects ---

console.log('Test 1: Rejects empty content');
{
  const r = gateCheck('');
  assert(!r.pass, 'Empty string should fail');
  assert(r.reason === 'empty', `Expected reason 'empty', got '${r.reason}'`);
}

console.log('Test 2: Rejects null/undefined');
{
  assert(!gateCheck(null).pass, 'null should fail');
  assert(!gateCheck(undefined).pass, 'undefined should fail');
}

console.log('Test 3: Rejects too short content');
{
  const r = gateCheck('Short');
  assert(!r.pass, 'Short content should fail');
  assert(r.reason === 'too_short', `Expected reason 'too_short', got '${r.reason}'`);
}

console.log('Test 4: Rejects too short after stripping bullets/tags');
{
  const r = gateCheck('- [fact] Hi');
  assert(!r.pass, 'Short content after stripping should fail');
  assert(r.reason === 'too_short', `Expected too_short, got '${r.reason}'`);
}

console.log('Test 5: Rejects URL-only content');
{
  const r = gateCheck('https://example.com/some/path');
  assert(!r.pass, 'URL-only should fail');
  assert(r.reason === 'url_only', `Expected 'url_only', got '${r.reason}'`);
}

console.log('Test 6: Rejects system noise');
{
  for (const noise of ['HEARTBEAT_OK', 'NO_REPLY', '✅', '❌', 'session started something', 'auto-indexed 5 files']) {
    const r = gateCheck(noise);
    assert(!r.pass, `"${noise}" should be rejected as system noise`);
  }
}

console.log('Test 7: Rejects code noise');
{
  for (const code of ['```javascript\nconsole.log(1)', 'import React from "react"', 'const x = 42; // some value', 'function doThing() { return 1; }', '// This is a comment line here']) {
    const r = gateCheck(code);
    assert(!r.pass, `"${code.slice(0, 30)}..." should be rejected as code noise`);
  }
}

console.log('Test 8: Rejects timestamp-only');
{
  const r = gateCheck('2026-03-07T14:30:00');
  assert(!r.pass, 'Timestamp-only should fail');
  assert(r.reason === 'timestamp_only', `Expected 'timestamp_only', got '${r.reason}'`);
}

// --- Passes ---

console.log('Test 9: Passes valid content');
{
  const r = gateCheck('JB prefers warm lighting in the office');
  assert(r.pass, 'Valid content should pass');
  assert(!r.reason, 'Should have no reason');
}

console.log('Test 10: Passes tagged content with bullets');
{
  const r = gateCheck('- [decision] Use PostgreSQL for the main database');
  assert(r.pass, 'Tagged content should pass');
}

console.log('Test 11: Code noise exempt for decision/preference tags');
{
  const r = gateCheck('[decision] const DATABASE = "postgresql" — chose this over MySQL');
  assert(r.pass, 'Code-like content tagged as decision should pass');
}

console.log('Test 12: URL with description passes');
{
  const r = gateCheck('Check https://example.com for the API docs on authentication');
  assert(r.pass, 'URL with surrounding text should pass');
}

// --- Config ---

console.log('Test 13: enabled=false bypasses all checks');
{
  const r = gateCheck('Hi', { enabled: false });
  assert(r.pass, 'Should pass when gate disabled');
}

console.log('Test 14: Custom minLength');
{
  const r = gateCheck('Short text here', { minLength: 5 });
  assert(r.pass, 'Should pass with lower minLength');
}

console.log('Test 15: Disable individual filters');
{
  const r1 = gateCheck('https://example.com/path', { filterUrlOnly: false });
  assert(r1.pass, 'URL should pass when filterUrlOnly=false');

  const r2 = gateCheck('HEARTBEAT_OK system check', { filterSystemNoise: false });
  assert(r2.pass, 'System noise should pass when filterSystemNoise=false');

  const r3 = gateCheck('import something from somewhere here', { filterCodeNoise: false });
  assert(r3.pass, 'Code should pass when filterCodeNoise=false');
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
