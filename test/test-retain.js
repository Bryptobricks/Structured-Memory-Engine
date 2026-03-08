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

// Test 6: Heuristic classification — preference
console.log('Test 6: Heuristic — preference detection');
const heuristic1 = `
## Random Notes
- JB prefers warm lighting for the office
- Some random text that is not classifiable
`.trim();
const facts6 = extractFacts(heuristic1, 'test.md');
const prefFact = facts6.find(f => f.content.includes('warm lighting'));
assert(prefFact != null, 'Should find the preference bullet');
assert(prefFact.type === 'preference', `Expected 'preference', got '${prefFact && prefFact.type}'`);
assert(prefFact.confidence === 0.7, `Expected confidence 0.7, got ${prefFact && prefFact.confidence}`);

// Test 7: Heuristic classification — decision
console.log('Test 7: Heuristic — decision detection');
const heuristic2 = `
- Decided to use PostgreSQL for everything
`.trim();
const facts7 = extractFacts(heuristic2, 'test.md');
assert(facts7.length === 1, `Expected 1 fact, got ${facts7.length}`);
assert(facts7[0].type === 'decision', `Expected 'decision', got '${facts7[0].type}'`);

// Test 8: Heuristic classification — fact (medical/health)
console.log('Test 8: Heuristic — fact detection (health)');
const heuristic3 = `
- Bought EVEDAL lamp at IKEA for the office
- Takes 5mg creatine daily in the morning
`.trim();
const facts8 = extractFacts(heuristic3, 'test.md');
assert(facts8.length === 2, `Expected 2 facts, got ${facts8.length}`);
assert(facts8.every(f => f.type === 'fact'), 'Both should be type fact');

// Test 9: Heuristic — already tagged NOT re-classified
console.log('Test 9: Heuristic — already tagged lines not re-classified');
const heuristic4 = `
- [confirmed] JB prefers dark mode on everything
`.trim();
const facts9 = extractFacts(heuristic4, 'test.md');
assert(facts9.length === 1, `Expected 1 fact, got ${facts9.length}`);
assert(facts9[0].type === 'confirmed', `Should keep original type 'confirmed', got '${facts9[0].type}'`);
assert(facts9[0].confidence === 1.0, `Should keep original confidence 1.0, got ${facts9[0].confidence}`);

// Test 10: Heuristic — short lines skipped
console.log('Test 10: Heuristic — short lines skipped');
const heuristic5 = `
- Likes it
- Very short
`.trim();
const facts10 = extractFacts(heuristic5, 'test.md');
assert(facts10.length === 0, `Expected 0 facts (too short for heuristic), got ${facts10.length}`);

// Test 11: Heuristic — non-matching bullets stay raw (not extracted)
console.log('Test 11: Non-matching bullets not classified');
const heuristic6 = `
- The meeting was productive and went well overall
- Also discussed the roadmap timeline with the team
`.trim();
const facts11 = extractFacts(heuristic6, 'test.md');
assert(facts11.length === 0, `Expected 0 facts (no heuristic match), got ${facts11.length}`);

// Test 12: Heuristic disabled via config
console.log('Test 12: Heuristic disabled via config');
const heuristic7 = `
- JB prefers warm lighting for the office
`.trim();
const facts12 = extractFacts(heuristic7, 'test.md', { heuristicClassification: false });
assert(facts12.length === 0, `Expected 0 facts with heuristic disabled, got ${facts12.length}`);

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
