#!/usr/bin/env node
/**
 * Tests for v8.0 Recall Quality Benchmarking (Item 5)
 */
const { gradeResult } = require('../lib/benchmark');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ─── Test 1: gradeResult PASS — all expected content found ───
console.log('Test 1: gradeResult PASS');
{
  const test = {
    id: 'test-pass',
    query: 'supplements',
    expectedContent: ['stack', 'creatine'],
    expectedTypes: ['fact'],
    minRelevantInTop3: 1,
  };
  const recallResults = [
    { content: 'Current Stack: creatine 5g daily', chunkType: 'fact' },
    { content: 'Supplements review complete', chunkType: 'fact' },
    { content: 'Workout routine updated', chunkType: 'fact' },
  ];
  const grade = gradeResult(test, recallResults);
  assert(grade.grade === 'PASS', `Expected PASS, got ${grade.grade} (score: ${grade.score.toFixed(2)})`);
  assert(grade.contentHits === 2, `Should hit both content terms, got ${grade.contentHits}`);
}

// ─── Test 2: gradeResult FAIL — nothing found ───
console.log('Test 2: gradeResult FAIL — empty results');
{
  const test = {
    id: 'test-fail',
    query: 'supplements',
    expectedContent: ['stack', 'creatine'],
    expectedTypes: ['fact'],
    minRelevantInTop3: 1,
  };
  const grade = gradeResult(test, []);
  assert(grade.grade === 'FAIL', `Expected FAIL, got ${grade.grade}`);
  assert(grade.contentHits === 0, `Should hit 0 content terms, got ${grade.contentHits}`);
}

// ─── Test 3: gradeResult PARTIAL — some content found ───
console.log('Test 3: gradeResult PARTIAL');
{
  const test = {
    id: 'test-partial',
    query: 'supplements',
    expectedContent: ['stack', 'creatine', 'vitamin', 'magnesium'],
    expectedTypes: ['fact', 'decision'],
    minRelevantInTop3: 2,
  };
  const recallResults = [
    { content: 'Creatine 5g daily started Feb 23', chunkType: 'fact' },
    { content: 'Random unrelated content here', chunkType: 'raw' },
    { content: 'More unrelated stuff', chunkType: 'raw' },
  ];
  const grade = gradeResult(test, recallResults);
  assert(grade.grade === 'PARTIAL' || grade.grade === 'FAIL',
    `Expected PARTIAL or FAIL for partial match, got ${grade.grade} (score: ${grade.score.toFixed(2)})`);
}

// ─── Test 4: Content hit rate calculation ───
console.log('Test 4: Content hit rate calculation');
{
  const test = {
    id: 'test-rate',
    query: 'test',
    expectedContent: ['alpha', 'beta', 'gamma', 'delta'],
    expectedTypes: [],
    minRelevantInTop3: 0,
  };
  const recallResults = [
    { content: 'alpha and beta content', chunkType: 'fact' },
    { content: 'gamma stuff here', chunkType: 'fact' },
  ];
  const grade = gradeResult(test, recallResults);
  assert(grade.contentHits === 3, `Should find 3 of 4 terms, got ${grade.contentHits}`);
}

// ─── Test 5: Type hit rate calculation ───
console.log('Test 5: Type hit rate calculation');
{
  const test = {
    id: 'test-types',
    query: 'test',
    expectedContent: [],
    expectedTypes: ['fact', 'decision'],
    minRelevantInTop3: 0,
  };
  const recallResults = [
    { content: 'a fact', chunkType: 'fact' },
    { content: 'a decision', chunkType: 'decision' },
    { content: 'raw noise', chunkType: 'raw' },
  ];
  const grade = gradeResult(test, recallResults);
  assert(grade.typeHits === 2, `Should find both types, got ${grade.typeHits}`);
  assert(grade.grade === 'PASS', `Should PASS with all types found, got ${grade.grade}`);
}

// ─── Test 6: No expected content → always passes content check ───
console.log('Test 6: No expected content → passes');
{
  const test = {
    id: 'test-noexpect',
    query: 'what happened yesterday',
    expectedContent: [],
    expectedTypes: [],
    minRelevantInTop3: 0,
  };
  const grade = gradeResult(test, [{ content: 'anything', chunkType: 'raw' }]);
  assert(grade.grade === 'PASS', `No expectations should PASS, got ${grade.grade}`);
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
