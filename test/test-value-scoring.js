#!/usr/bin/env node
/**
 * Tests for multi-feature value scoring module.
 */
const { computeFeatures, computeValueScore, classifyValue, assessChunkValue } = require('../lib/value-scoring');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function approx(a, b, tolerance = 0.05) {
  return Math.abs(a - b) < tolerance;
}

// --- Personal fact ---

console.log('Test 1: Personal fact — high personal, low noise');
{
  const f = computeFeatures({ content: 'JB weighs 197 lbs', chunk_type: 'fact', confidence: 1.0 });
  assert(f.personal_relevance === 1.0, `Expected personal 1.0, got ${f.personal_relevance}`);
  assert(f.operational_noise === 0.0, `Expected noise 0.0, got ${f.operational_noise}`);
}

// --- Build log ---

console.log('Test 2: Build log — high noise, low personal');
{
  const f = computeFeatures({ content: 'pipeline run: built 5 items from script endpoint', chunk_type: 'raw', confidence: 0.5 });
  assert(f.operational_noise >= 0.5, `Expected noise >= 0.5, got ${f.operational_noise}`);
  assert(f.personal_relevance === 0.0, `Expected personal 0.0, got ${f.personal_relevance}`);
}

// --- Decision ---

console.log('Test 3: Decision — high durability and personal');
{
  const f = computeFeatures({ content: 'Switched from NOW Foods to Nutricost for supplements', chunk_type: 'decision', confidence: 1.0 });
  assert(f.durability === 1.0, `Expected durability 1.0 for decision, got ${f.durability}`);
  assert(f.personal_relevance === 1.0, `Expected personal 1.0, got ${f.personal_relevance}`);
}

// --- Vague raw chunk ---

console.log('Test 4: Vague raw chunk — low specificity');
{
  const f = computeFeatures({ content: 'some stuff happened', chunk_type: 'raw', confidence: 0.5 });
  assert(f.specificity < 0.3, `Expected low specificity, got ${f.specificity}`);
  assert(f.durability <= 0.1, `Expected low durability for raw, got ${f.durability}`);
  const v = computeValueScore(f);
  const label = classifyValue(v);
  assert(label === 'noise' || label === 'junk', `Expected noise/junk, got ${label} (score: ${v.toFixed(3)})`);
}

// --- Health baseline ---

console.log('Test 5: Health baseline — core value');
{
  const a = assessChunkValue({ content: 'creatinine 1.13 mg/dL — baseline reference', chunk_type: 'fact', confidence: 1.0 });
  assert(a.features.personal_relevance === 1.0, 'Personal: health lab result');
  assert(a.features.durability >= 0.7, `Durability should be >= 0.7, got ${a.features.durability}`);
  assert(a.valueLabel === 'core' || a.valueLabel === 'situational', `Expected core/situational, got ${a.valueLabel} (score: ${a.valueScore.toFixed(3)})`);
}

// --- System output ---

console.log('Test 6: System output — junk value');
{
  const a = assessChunkValue({ content: 'auto-indexed 45 files in the workspace session started via cron script', chunk_type: 'raw', confidence: 0.5 });
  assert(a.features.operational_noise >= 0.5, `Expected high noise, got ${a.features.operational_noise}`);
  assert(a.valueLabel === 'junk' || a.valueLabel === 'noise', `Expected junk/noise, got ${a.valueLabel} (score: ${a.valueScore.toFixed(3)})`);
}

// --- classifyValue thresholds ---

console.log('Test 7: classifyValue thresholds');
{
  assert(classifyValue(0.85) === 'core', '0.85 → core');
  assert(classifyValue(0.70) === 'core', '0.70 → core');
  assert(classifyValue(0.50) === 'situational', '0.50 → situational');
  assert(classifyValue(0.35) === 'situational', '0.35 → situational');
  assert(classifyValue(0.20) === 'noise', '0.20 → noise');
  assert(classifyValue(0.15) === 'noise', '0.15 → noise');
  assert(classifyValue(0.10) === 'junk', '0.10 → junk');
  assert(classifyValue(0.0) === 'junk', '0.0 → junk');
}

// --- computeValueScore clamping ---

console.log('Test 8: Value score clamped to 0-1');
{
  // All positive features maxed
  const high = computeValueScore({ personal_relevance: 1.0, operational_noise: 0.0, specificity: 1.0, durability: 1.0, retrieval_utility: 1.0 });
  assert(high <= 1.0, `Should be <= 1.0, got ${high}`);
  assert(high >= 0.8, `All-max should be >= 0.8, got ${high}`);

  // All negative
  const low = computeValueScore({ personal_relevance: 0.0, operational_noise: 1.0, specificity: 0.0, durability: 0.0, retrieval_utility: 0.0 });
  assert(low >= 0.0, `Should be >= 0.0, got ${low}`);
}

// --- Specificity bonus for numbers ---

console.log('Test 9: Specificity bonus for numbers');
{
  const withNumbers = computeFeatures({ content: 'Takes 5mg creatine daily for performance', chunk_type: 'fact', confidence: 1.0 });
  const withoutNumbers = computeFeatures({ content: 'Takes creatine daily for performance', chunk_type: 'fact', confidence: 1.0 });
  assert(withNumbers.specificity > withoutNumbers.specificity, `Numbers should boost specificity: ${withNumbers.specificity} > ${withoutNumbers.specificity}`);
}

// --- Confirmed type gets max durability ---

console.log('Test 10: Confirmed type gets durability 1.0');
{
  const f = computeFeatures({ content: 'some confirmed information here', chunk_type: 'confirmed', confidence: 1.0 });
  assert(f.durability === 1.0, `Expected 1.0, got ${f.durability}`);
}

// --- Durable patterns boost durability ---

console.log('Test 11: Durable patterns boost raw chunks');
{
  const f = computeFeatures({ content: 'JB married to Parri, his partner since 2020', chunk_type: 'raw', confidence: 1.0 });
  assert(f.durability >= 0.3, `Durable pattern should boost raw from 0.1, got ${f.durability}`);
}

// --- File path noise ---

console.log('Test 12: File paths trigger noise');
{
  const f = computeFeatures({ content: 'Modified /Users/jb/Projects/test.js file', chunk_type: 'raw', confidence: 0.5 });
  assert(f.operational_noise >= 0.25, `File paths should trigger noise, got ${f.operational_noise}`);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
