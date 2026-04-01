#!/usr/bin/env node
/**
 * Tests for priority classification (v9: priority-weighted chunks).
 */
const { classifyPriority } = require('../lib/value-scoring');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

// --- High priority: personal fact ---

console.log('Test 1: Personal fact — high priority');
{
  const p = classifyPriority({ content: 'JB weighs 197 lbs', chunk_type: 'fact', confidence: 1.0 });
  assert(p === 'high', `Expected high, got ${p}`);
}

// --- Low priority: ops noise ---

console.log('Test 2: Ops noise — low priority');
{
  const p = classifyPriority({ content: 'cron job ran at 2am, pipeline phase 3 complete', chunk_type: 'raw', confidence: 0.5 });
  assert(p === 'low', `Expected low, got ${p}`);
}

// --- High priority: decision ---

console.log('Test 3: Decision type — high priority');
{
  const p = classifyPriority({ content: 'decided to switch from X to Y', chunk_type: 'decision', confidence: 1.0 });
  assert(p === 'high', `Expected high, got ${p}`);
}

// --- Low priority: vague content ---

console.log('Test 4: Vague content — low priority');
{
  const p = classifyPriority({ content: 'some stuff happened', chunk_type: 'raw', confidence: 0.5 });
  assert(p === 'low', `Expected low, got ${p}`);
}

// --- Medium priority: regular fact ---

console.log('Test 5: Regular fact — medium priority');
{
  const p = classifyPriority({ content: 'The meeting was scheduled for 3pm in the conference room', chunk_type: 'fact', confidence: 0.8 });
  assert(p === 'medium', `Expected medium, got ${p}`);
}

// --- High priority: confirmed type ---

console.log('Test 6: Confirmed type — high priority');
{
  const p = classifyPriority({ content: 'some confirmed information', chunk_type: 'confirmed', confidence: 1.0 });
  assert(p === 'high', `Expected high, got ${p}`);
}

// --- High priority: large financial amount ---

console.log('Test 7: Large financial amount — high priority');
{
  const p = classifyPriority({ content: 'Portfolio rebalanced, moved $15,000 to staking', chunk_type: 'fact', confidence: 1.0 });
  assert(p === 'high', `Expected high, got ${p}`);
}

// --- Medium priority: small financial amount ---

console.log('Test 8: Small financial amount — not auto-high');
{
  const p = classifyPriority({ content: 'Spent $25 on lunch today at the cafe downtown', chunk_type: 'fact', confidence: 0.8 });
  assert(p === 'medium', `Expected medium, got ${p}`);
}

// --- High priority: health/medication ---

console.log('Test 9: Health content — high priority');
{
  const p = classifyPriority({ content: 'Started new prescription for blood pressure medication', chunk_type: 'fact', confidence: 1.0 });
  assert(p === 'high', `Expected high, got ${p}`);
}

// --- Low priority: inferred type ---

console.log('Test 10: Inferred type — low priority');
{
  // Personal patterns take precedence (high checks run before low)
  const p = classifyPriority({ content: 'The server appears to run faster during night hours', chunk_type: 'inferred', confidence: 0.5 });
  assert(p === 'low', `Expected low, got ${p}`);
}

// --- Low priority: very short content ---

console.log('Test 11: Very short content — low priority');
{
  const p = classifyPriority({ content: 'ok noted', chunk_type: 'fact', confidence: 0.5 });
  assert(p === 'low', `Expected low, got ${p}`);
}

// --- High priority: durable pattern (identity) ---

console.log('Test 12: Durable pattern — high priority');
{
  const p = classifyPriority({ content: 'JB blood type is O positive', chunk_type: 'fact', confidence: 1.0 });
  assert(p === 'high', `Expected high, got ${p}`);
}

// --- Medium priority: preference type (not personal pattern match) ---

console.log('Test 13: Preference type without personal pattern — medium');
{
  const p = classifyPriority({ content: 'The team uses Slack for communication', chunk_type: 'preference', confidence: 0.8 });
  assert(p === 'medium', `Expected medium, got ${p}`);
}

// --- Null/undefined handling ---

console.log('Test 14: Missing fields handled gracefully');
{
  const p = classifyPriority({ content: '', chunk_type: null, confidence: null });
  assert(p === 'low', `Expected low for empty content, got ${p}`);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
