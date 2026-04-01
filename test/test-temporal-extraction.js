#!/usr/bin/env node
/**
 * Tests for extractReferencedDate() — v9 three-date temporal model.
 */
const { extractReferencedDate } = require('../lib/temporal');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

// Fixed reference date: Wednesday April 1 2026
const NOW = new Date(2026, 3, 1, 12, 0, 0);

// --- Explicit dates ---

console.log('Test 1: Named date — "my flight is January 31"');
{
  const r = extractReferencedDate('my flight is January 31', NOW);
  assert(r.referencedDate === '2026-01-31', `Expected 2026-01-31, got ${r.referencedDate}`);
  assert(r.relativeOffset < 0, `Expected negative offset, got ${r.relativeOffset}`);
}

console.log('Test 2: Named date with year — "March 5th 2026"');
{
  const r = extractReferencedDate('appointment on March 5th 2026', NOW);
  assert(r.referencedDate === '2026-03-05', `Expected 2026-03-05, got ${r.referencedDate}`);
}

console.log('Test 3: US date — "DOB: 12/22/1997"');
{
  const r = extractReferencedDate('DOB: 12/22/1997', NOW);
  assert(r.referencedDate === '1997-12-22', `Expected 1997-12-22, got ${r.referencedDate}`);
  assert(r.relativeOffset < -10000, `Expected large negative offset for DOB, got ${r.relativeOffset}`);
}

console.log('Test 4: ISO date — "deadline 2026-04-15"');
{
  const r = extractReferencedDate('deadline 2026-04-15', NOW);
  assert(r.referencedDate === '2026-04-15', `Expected 2026-04-15, got ${r.referencedDate}`);
  assert(r.relativeOffset === 14, `Expected +14 offset, got ${r.relativeOffset}`);
}

// --- Relative references ---

console.log('Test 5: "yesterday" resolves correctly');
{
  const r = extractReferencedDate('decided yesterday to change supplements', NOW);
  assert(r.referencedDate === '2026-03-31', `Expected 2026-03-31, got ${r.referencedDate}`);
  assert(r.relativeOffset === -1, `Expected -1, got ${r.relativeOffset}`);
}

console.log('Test 6: "tomorrow" resolves correctly');
{
  const r = extractReferencedDate('meeting tomorrow at 3pm', NOW);
  assert(r.referencedDate === '2026-04-02', `Expected 2026-04-02, got ${r.referencedDate}`);
  assert(r.relativeOffset === 1, `Expected 1, got ${r.relativeOffset}`);
}

console.log('Test 7: "today" resolves correctly');
{
  const r = extractReferencedDate('started today with a new routine', NOW);
  assert(r.referencedDate === '2026-04-01', `Expected 2026-04-01, got ${r.referencedDate}`);
  assert(r.relativeOffset === 0, `Expected 0, got ${r.relativeOffset}`);
}

console.log('Test 8: "in 3 days"');
{
  const r = extractReferencedDate('package arrives in 3 days', NOW);
  assert(r.referencedDate === '2026-04-04', `Expected 2026-04-04, got ${r.referencedDate}`);
  assert(r.relativeOffset === 3, `Expected 3, got ${r.relativeOffset}`);
}

console.log('Test 9: "5 days ago"');
{
  const r = extractReferencedDate('started 5 days ago', NOW);
  assert(r.referencedDate === '2026-03-27', `Expected 2026-03-27, got ${r.referencedDate}`);
  assert(r.relativeOffset === -5, `Expected -5, got ${r.relativeOffset}`);
}

console.log('Test 10: "last Tuesday"');
{
  // April 1 2026 is Wednesday. Last Tuesday = March 31.
  const r = extractReferencedDate('decided last Tuesday to switch', NOW);
  assert(r.referencedDate === '2026-03-31', `Expected 2026-03-31, got ${r.referencedDate}`);
  assert(r.relativeOffset === -1, `Expected -1, got ${r.relativeOffset}`);
}

console.log('Test 11: "next Friday"');
{
  // April 1 2026 is Wednesday. Next Friday = April 3.
  const r = extractReferencedDate('appointment next Friday', NOW);
  assert(r.referencedDate === '2026-04-03', `Expected 2026-04-03, got ${r.referencedDate}`);
  assert(r.relativeOffset === 2, `Expected 2, got ${r.relativeOffset}`);
}

// --- No date ---

console.log('Test 12: No date in content');
{
  const r = extractReferencedDate('JB weighs 197 lbs', NOW);
  assert(r.referencedDate === null, `Expected null, got ${r.referencedDate}`);
  assert(r.relativeOffset === null, `Expected null, got ${r.relativeOffset}`);
}

// --- Multiple dates: most specific wins (explicit > relative) ---

console.log('Test 13: Multiple dates — explicit wins over relative');
{
  // ISO date should be picked (priority 1) even though "yesterday" is also present
  const r = extractReferencedDate('yesterday I booked a flight for 2026-06-15', NOW);
  assert(r.referencedDate === '2026-06-15', `Expected ISO date 2026-06-15, got ${r.referencedDate}`);
}

// --- Edge cases ---

console.log('Test 14: Empty/short content');
{
  const r = extractReferencedDate('', NOW);
  assert(r.referencedDate === null, 'Empty string should return null');
  const r2 = extractReferencedDate('hi', NOW);
  assert(r2.referencedDate === null, 'Short string should return null');
}

console.log('Test 15: Abbreviated month — "Feb 14"');
{
  const r = extractReferencedDate('valentines Feb 14', NOW);
  assert(r.referencedDate === '2026-02-14', `Expected 2026-02-14, got ${r.referencedDate}`);
}

console.log('Test 16: Day abbreviation — "last wed"');
{
  // April 1 2026 is Wednesday. Last wed = March 25.
  const r = extractReferencedDate('had a meeting last wed', NOW);
  assert(r.referencedDate === '2026-03-25', `Expected 2026-03-25, got ${r.referencedDate}`);
  assert(r.relativeOffset === -7, `Expected -7, got ${r.relativeOffset}`);
}

console.log('Test 17: "N days from now"');
{
  const r = extractReferencedDate('results expected 10 days from now', NOW);
  assert(r.referencedDate === '2026-04-11', `Expected 2026-04-11, got ${r.referencedDate}`);
  assert(r.relativeOffset === 10, `Expected 10, got ${r.relativeOffset}`);
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
