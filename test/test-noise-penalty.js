#!/usr/bin/env node
/**
 * Tests for operational noise penalty in scoring.js.
 */
const { score, opsNoisePenalty, OPS_NOISE_RE, NOISE_EXEMPT_TYPES, RECALL_PROFILE } = require('../lib/scoring');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const nowMs = Date.now();

// --- opsNoisePenalty ---

console.log('Test 1: Noise from today → no penalty');
{
  const chunk = { content: 'CC built 5 items from spec', created_at: new Date().toISOString(), chunk_type: 'raw' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 1.0, `Expected 1.0, got ${penalty}`);
}

console.log('Test 2: Noise from 2 days ago → 0.7x');
{
  const chunk = { content: 'pipeline run: built 5 items from spec', created_at: daysAgo(2), chunk_type: 'raw' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 0.7, `Expected 0.7, got ${penalty}`);
}

console.log('Test 3: Noise from 5 days ago → 0.4x');
{
  const chunk = { content: 'auto-indexed 45 files', created_at: daysAgo(5), chunk_type: 'raw' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 0.4, `Expected 0.4, got ${penalty}`);
}

console.log('Test 4: Noise from 2 weeks ago → 0.2x');
{
  const chunk = { content: 'auto-indexed 45 files', created_at: daysAgo(14), chunk_type: 'raw' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 0.2, `Expected 0.2, got ${penalty}`);
}

console.log('Test 5: Decision mentioning cron → exempt');
{
  const chunk = { content: 'decided to use cron for calendar checks', created_at: daysAgo(14), chunk_type: 'decision' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 1.0, `Expected 1.0 (exempt), got ${penalty}`);
}

console.log('Test 6: Preference mentioning config → exempt');
{
  const chunk = { content: 'prefers configuration via env vars', created_at: daysAgo(10), chunk_type: 'preference' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 1.0, `Expected 1.0 (exempt), got ${penalty}`);
}

console.log('Test 7: Confirmed mentioning API → exempt');
{
  const chunk = { content: 'API key is stored in vault', created_at: daysAgo(30), chunk_type: 'confirmed' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 1.0, `Expected 1.0 (exempt), got ${penalty}`);
}

console.log('Test 8: No noise pattern → no penalty');
{
  const chunk = { content: "JB's creatinine is 1.13", created_at: daysAgo(30), chunk_type: 'fact' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 1.0, `Expected 1.0, got ${penalty}`);
}

console.log('Test 9: Sub-agent from 10 days ago → 0.2x');
{
  const chunk = { content: 'sub-agent completed consensus research', created_at: daysAgo(10), chunk_type: 'raw' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 0.2, `Expected 0.2, got ${penalty}`);
}

console.log('Test 10: Session started from 3 days ago → 0.7x');
{
  const chunk = { content: 'session started with workspace init', created_at: daysAgo(3), chunk_type: 'raw' };
  const penalty = opsNoisePenalty(chunk, nowMs);
  assert(penalty === 0.7, `Expected 0.7, got ${penalty}`);
}

// --- Integration: noise penalty affects score() ---

console.log('Test 11: Noisy old chunk scores lower than clean old chunk');
{
  const base = { confidence: 1.0, file_weight: 1.0, _normalizedFts: 0.5, file_path: 'memory/2026-01-01.md' };
  const noisy = { ...base, content: 'auto-indexed 45 files in the workspace', created_at: daysAgo(14), chunk_type: 'raw' };
  const clean = { ...base, content: 'JB takes creatine 5g daily', created_at: daysAgo(14), chunk_type: 'fact' };

  const noisyScore = score(noisy, nowMs, RECALL_PROFILE);
  const cleanScore = score(clean, nowMs, RECALL_PROFILE);
  assert(cleanScore > noisyScore, `Clean (${cleanScore.toFixed(3)}) should beat noisy (${noisyScore.toFixed(3)})`);
}

console.log('Test 12: Noise patterns detected');
{
  const patterns = ['run: test', 'cron job', 'pipeline stage', 'phase 3 complete', 'webhook fired', 'heartbeat check', 'spawned worker', 'restart service'];
  for (const p of patterns) {
    assert(OPS_NOISE_RE.test(p), `Should match: "${p}"`);
  }
  assert(!OPS_NOISE_RE.test('JB prefers warm lighting'), 'Should not match non-noise');
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
