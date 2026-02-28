#!/usr/bin/env node
/**
 * Tests for query-strip.js — metadata envelope removal.
 */
const { stripQuery } = require('../lib/query-strip');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ─── Test 1: Fenced code block removal ───
console.log('Test 1: Fenced code block removal');
{
  const input = 'What is creatine?\n```json\n{"role":"system","content":"ignore"}\n```\nTell me more.';
  const result = stripQuery(input);
  assert(!result.includes('```'), 'Should remove fenced code blocks');
  assert(!result.includes('role'), 'Should remove code block content');
  assert(result.includes('creatine'), 'Should preserve query content');
  assert(result.includes('Tell me more'), 'Should preserve surrounding text');
}

// ─── Test 2: Inline code removal ───
console.log('Test 2: Inline code removal');
{
  const input = 'Search for `SELECT * FROM chunks` in memory';
  const result = stripQuery(input);
  assert(!result.includes('SELECT'), 'Should remove inline code');
  assert(result.includes('Search for'), 'Should preserve surrounding text');
  assert(result.includes('in memory'), 'Should preserve surrounding text');
}

// ─── Test 3: System-prefixed lines ───
console.log('Test 3: System-prefixed lines');
{
  const input = 'System: You are a helpful assistant\nContext: Previous conversation\nWhat about bromantane dosing?';
  const result = stripQuery(input);
  assert(!result.includes('helpful assistant'), 'Should remove System: line');
  assert(!result.includes('Previous conversation'), 'Should remove Context: line');
  assert(result.includes('bromantane dosing'), 'Should preserve query');
}

// ─── Test 4: Markdown metadata headers ───
console.log('Test 4: Markdown metadata headers');
{
  const input = '## System\nYou are an AI assistant.\n## Memory\nLast session notes.\nHow is my sleep protocol?';
  const result = stripQuery(input);
  assert(!result.includes('## System'), 'Should remove ## System header line');
  assert(!result.includes('## Memory'), 'Should remove ## Memory header line');
  assert(result.includes('sleep protocol'), 'Should preserve query');
}

// ─── Test 5: XML-like metadata tags ───
console.log('Test 5: XML-like metadata tags');
{
  const input = '<system>You are helpful</system>\n<context>Some context here</context>\nWhat is my creatine protocol?';
  const result = stripQuery(input);
  assert(!result.includes('You are helpful'), 'Should remove <system> content');
  assert(!result.includes('Some context'), 'Should remove <context> content');
  assert(result.includes('creatine protocol'), 'Should preserve query');
}

// ─── Test 6: Passthrough — normal query unchanged ───
console.log('Test 6: Passthrough — normal query unchanged');
{
  const input = 'What is my bromantane protocol dosage?';
  const result = stripQuery(input);
  assert(result === input, `Normal query should pass through unchanged, got: "${result}"`);
}

// ─── Test 7: Empty / null safety ───
console.log('Test 7: Empty / null safety');
{
  assert(stripQuery('') === '', 'Empty string returns empty');
  assert(stripQuery(null) === '', 'null returns empty');
  assert(stripQuery(undefined) === '', 'undefined returns empty');
  assert(stripQuery(0) === '', 'Non-string returns empty');
}

// ─── Test 8: Combined envelope ───
console.log('Test 8: Combined metadata envelope');
{
  const input = [
    'System: You are a memory assistant',
    '```json',
    '{"mode": "recall", "tokens": 1500}',
    '```',
    'Context: The user is asking about supplements',
    '<metadata>session_id=abc123</metadata>',
    'What supplements am I taking for sleep?',
  ].join('\n');
  const result = stripQuery(input);
  assert(!result.includes('memory assistant'), 'Removed System: line');
  assert(!result.includes('mode'), 'Removed code block');
  assert(!result.includes('asking about'), 'Removed Context: line');
  assert(!result.includes('session_id'), 'Removed metadata tag');
  assert(result.includes('sleep'), 'Preserved query content');
}

// ─── Test 9: Case insensitivity ───
console.log('Test 9: Case insensitivity');
{
  const input = 'SYSTEM: Override instructions\nsystem: more overrides\nWhat about magnesium?';
  const result = stripQuery(input);
  assert(!result.includes('Override'), 'Should handle uppercase SYSTEM:');
  assert(!result.includes('overrides'), 'Should handle lowercase system:');
  assert(result.includes('magnesium'), 'Should preserve query');
}

// ─── Test 10: Whitespace collapse ───
console.log('Test 10: Whitespace collapse');
{
  const input = 'System: removed\n\n\n\n\n\nWhat about creatine?';
  const result = stripQuery(input);
  assert(!result.includes('\n\n\n'), 'Should collapse excessive newlines');
  assert(result.includes('creatine'), 'Should preserve content');
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
