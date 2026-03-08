#!/usr/bin/env node
/**
 * Tests for temporal-freshness module — stale relative time detection.
 */
const { isStaleRelative, staleRelativePenalty, annotateStaleRelative, getRecordedDate, STALE_RELATIVE_PENALTY } = require('../lib/temporal-freshness');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const TODAY = '2026-03-07';

// --- isStaleRelative ---

console.log('Test 1: "today" from today → not stale');
{
  const r = isStaleRelative('JB bought creatine today', TODAY, TODAY);
  assert(!r.isStale, 'Should not be stale');
  assert(r.relativeTerms.includes('today'), 'Should detect "today"');
}

console.log('Test 2: "today" from 3 days ago → stale');
{
  const r = isStaleRelative('JB bought creatine today', '2026-03-04', TODAY);
  assert(r.isStale, 'Should be stale');
  assert(r.relativeTerms.includes('today'), 'Should detect "today"');
  assert(r.recordedDate === '2026-03-04', `Expected recorded date 2026-03-04, got ${r.recordedDate}`);
}

console.log('Test 3: "currently" from same day → not stale');
{
  const r = isStaleRelative('Currently taking 5mg creatine', TODAY, TODAY);
  assert(!r.isStale, 'Should not be stale');
  assert(r.relativeTerms.includes('currently'), 'Should detect "currently"');
}

console.log('Test 4: "currently" from last month → stale');
{
  const r = isStaleRelative('Currently taking 5mg creatine', '2026-02-07', TODAY);
  assert(r.isStale, 'Should be stale');
}

console.log('Test 5: No relative terms → not stale regardless of age');
{
  const r = isStaleRelative('JB takes 5mg creatine daily', '2025-01-01', TODAY);
  assert(!r.isStale, 'Should not be stale without relative terms');
  assert(r.relativeTerms.length === 0, 'Should have no relative terms');
}

console.log('Test 6: "yesterday" from 2 days ago → stale');
{
  const r = isStaleRelative('Yesterday I started the protocol', '2026-03-05', TODAY);
  assert(r.isStale, 'Should be stale — yesterday was not actually yesterday');
}

console.log('Test 7: "yesterday" from 1 day ago → not stale');
{
  const r = isStaleRelative('Yesterday I started the protocol', '2026-03-06', TODAY);
  assert(!r.isStale, 'Should not be stale — yesterday IS actually yesterday');
}

console.log('Test 8: "this morning" from today → not stale');
{
  const r = isStaleRelative('This morning I weighed 197 lbs', TODAY, TODAY);
  assert(!r.isStale, 'Should not be stale');
}

console.log('Test 9: "this morning" from a week ago → stale');
{
  const r = isStaleRelative('This morning I weighed 197 lbs', '2026-02-28', TODAY);
  assert(r.isStale, 'Should be stale');
}

console.log('Test 10: "temporarily" from today → not stale');
{
  const r = isStaleRelative('Temporarily paused the supplement', TODAY, TODAY);
  assert(!r.isStale, 'Should not be stale');
}

console.log('Test 11: "temporarily" from 3 days ago → stale');
{
  const r = isStaleRelative('Temporarily paused the supplement', '2026-03-04', TODAY);
  assert(r.isStale, 'Should be stale');
}

console.log('Test 12: Multiple relative terms detected');
{
  const r = isStaleRelative('Today I am currently taking the dose right now', '2026-03-04', TODAY);
  assert(r.isStale, 'Should be stale');
  assert(r.relativeTerms.length >= 3, `Expected 3+ terms, got ${r.relativeTerms.length}`);
}

console.log('Test 13: Null/empty inputs handled');
{
  assert(!isStaleRelative(null, TODAY, TODAY).isStale, 'null content → not stale');
  assert(!isStaleRelative('today test', null, TODAY).isStale, 'null date → not stale');
  assert(!isStaleRelative('', TODAY, TODAY).isStale, 'empty content → not stale');
}

// --- staleRelativePenalty ---

console.log('Test 14: staleRelativePenalty — not stale = 1.0');
{
  const chunk = { content: 'JB takes creatine daily', file_path: 'memory/2026-03-07.md', created_at: '2026-03-07T10:00:00Z' };
  const penalty = staleRelativePenalty(chunk, TODAY);
  assert(penalty === 1.0, `Expected 1.0, got ${penalty}`);
}

console.log('Test 15: staleRelativePenalty — stale = 0.35');
{
  const chunk = { content: 'Today I bought new supplements', file_path: 'memory/2026-03-01.md', created_at: '2026-03-01T10:00:00Z' };
  const penalty = staleRelativePenalty(chunk, TODAY);
  assert(penalty === STALE_RELATIVE_PENALTY, `Expected ${STALE_RELATIVE_PENALTY}, got ${penalty}`);
}

// --- getRecordedDate ---

console.log('Test 16: getRecordedDate — from file path');
{
  const date = getRecordedDate({ file_path: 'memory/2026-03-05.md', created_at: '2026-03-06T10:00:00Z' });
  assert(date === '2026-03-05', `Expected 2026-03-05, got ${date}`);
}

console.log('Test 17: getRecordedDate — fallback to created_at');
{
  const date = getRecordedDate({ file_path: 'MEMORY.md', created_at: '2026-03-06T10:00:00Z' });
  assert(date === '2026-03-06', `Expected 2026-03-06, got ${date}`);
}

// --- annotateStaleRelative ---

console.log('Test 18: Content annotation includes recorded date');
{
  const annotated = annotateStaleRelative('Today I bought creatine', '2026-03-01');
  assert(annotated.includes('Recorded on 2026-03-01'), 'Should include recorded date');
  assert(annotated.includes('relative dates refer to that date'), 'Should include context note');
  assert(annotated.includes('Today I bought creatine'), 'Should include original content');
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
