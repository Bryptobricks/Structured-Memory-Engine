#!/usr/bin/env node
/**
 * Basic tests for extractFacts()
 */
const { extractFacts, TAG_CONFIDENCE, TAG_TYPE } = require('../lib/retain');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Test 1: Tagged facts
console.log('Test 1: Tagged facts');
const tagged = `
[fact] Alex takes creatine 25mg daily
[decision] Use FTS5 over vector DB
[pref] No over-engineering
[opinion] Creatine is better than pre-workout
[confirmed] Alex's timezone is PST
[inferred] Alex prefers dark mode
[outdated?] Alex takes 1.75mg fish oil
`.trim();

const facts1 = extractFacts(tagged, 'test.md');
assert(facts1.length === 7, `Expected 7 facts, got ${facts1.length}`);
assert(facts1[0].type === 'fact', `Expected type 'fact', got '${facts1[0].type}'`);
assert(facts1[0].confidence === 1.0, `Expected confidence 1.0, got ${facts1[0].confidence}`);
assert(facts1[4].type === 'confirmed', `Expected type 'confirmed', got '${facts1[4].type}'`);
assert(facts1[5].type === 'inferred', `Expected type 'inferred', got '${facts1[5].type}'`);
assert(facts1[5].confidence === 0.7, `Expected confidence 0.7, got ${facts1[5].confidence}`);
assert(facts1[6].type === 'outdated', `Expected type 'outdated', got '${facts1[6].type}'`);
assert(facts1[6].confidence === 0.3, `Expected confidence 0.3, got ${facts1[6].confidence}`);

// Test 2: Empty content tags
console.log('Test 2: Empty content guard');
const empty = `[fact] \n[fact]   \n[fact] Real content here`;
const facts2 = extractFacts(empty, 'test.md');
assert(facts2.length === 1, `Expected 1 fact (skipping empty), got ${facts2.length}`);
assert(facts2[0].content === 'Real content here', `Expected 'Real content here', got '${facts2[0].content}'`);

// Test 3: Heading-based extraction
console.log('Test 3: Heading-based bullets');
const headings = `
## Key Decisions
- Use SQLite for storage
- FTS5 for search

## What I Learned
- Creatine improves ATP production

## Random Section
- This should NOT be extracted
`.trim();

const facts3 = extractFacts(headings, 'test.md');
assert(facts3.length === 3, `Expected 3 heading facts, got ${facts3.length}`);
assert(facts3[0].type === 'decision', `Expected 'decision', got '${facts3[0].type}'`);
assert(facts3[2].type === 'fact', `Expected 'fact' from Learned heading, got '${facts3[2].type}'`);

// Test 4: Entity extraction
console.log('Test 4: Entity extraction');
const entities = `[fact] **Creatine** from @SupplyCo is great`;
const facts4 = extractFacts(entities, 'test.md');
assert(facts4[0].entities.includes('Creatine'), `Expected entity 'Creatine'`);
assert(facts4[0].entities.includes('@SupplyCo'), `Expected entity '@SupplyCo'`);

// Test 5: Dedup (tagged line under known heading shouldn't double-count)
console.log('Test 5: No double-count for tagged lines under headings');
const dedup = `
## Decisions
- [decision] Use FTS5
- Untagged decision
`.trim();

const facts5 = extractFacts(dedup, 'test.md');
assert(facts5.length === 2, `Expected 2 facts (no dupes), got ${facts5.length}`);

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
