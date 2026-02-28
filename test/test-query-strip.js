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

// ─── Test 11: Metadata label with parenthetical qualifier ───
console.log('Test 11: Metadata label with parenthetical qualifier');
{
  const input = 'Conversation info (untrusted metadata):\n\nWhat is my portfolio?';
  const result = stripQuery(input);
  assert(!result.includes('Conversation info'), 'Should remove metadata label line');
  assert(!result.includes('untrusted'), 'Should remove parenthetical qualifier');
  assert(result.includes('portfolio'), 'Should preserve query');
}

// ─── Test 12: Metadata label + fenced block combo ───
console.log('Test 12: Metadata label + fenced block combo');
{
  const input = 'Conversation info (untrusted metadata):\n```json\n{"timestamp": "now"}\n```\n\nHow am I investing?';
  const result = stripQuery(input);
  assert(!result.includes('Conversation'), 'Should remove label line');
  assert(!result.includes('timestamp'), 'Should remove code block');
  assert(result.includes('investing'), 'Should preserve query');
}

// ─── Test 13: System timestamp + metadata label + fenced block ───
console.log('Test 13: Full envelope — system + label + code block');
{
  const input = 'System: [2026-02-28 10:30:04 PST] Cron: HEARTBEAT_OK\n\nConversation info (untrusted metadata):\n```json\n{"ts": "now"}\n```\n\nWhat did I learn?';
  const result = stripQuery(input);
  assert(!result.includes('HEARTBEAT'), 'Should remove System: line');
  assert(!result.includes('Conversation'), 'Should remove metadata label');
  assert(!result.includes('ts'), 'Should remove code block');
  assert(result.includes('learn'), 'Should preserve query');
}

// ─── Test 14: Recalled Context section stripped ───
console.log('Test 14: Recalled Context section stripped');
{
  const input = '## Recalled Context\nStructured memories retrieved by relevance.\n\n- creatine 5g daily\n  ↳ memory/2026-02-20.md:1 [fact]\n- magnesium 400mg\n  ↳ memory/2026-02-20.md:3 [fact]\n\nWhat else should I take?';
  const result = stripQuery(input);
  assert(!result.includes('Recalled Context'), 'Should remove section header');
  assert(!result.includes('creatine'), 'Should remove recalled chunk content');
  assert(!result.includes('magnesium'), 'Should remove recalled chunk content');
  assert(result.includes('should I take'), 'Should preserve query');
}

// ─── Test 15: Other parenthetical labels pass through ───
console.log('Test 15: Non-metadata parenthetical labels pass through');
{
  const input = 'Tom (project lead): mentioned the deadline\nWhat about the timeline?';
  const result = stripQuery(input);
  assert(result.includes('Tom'), 'Non-metadata parenthetical should survive');
  assert(result.includes('timeline'), 'Query should survive');
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
