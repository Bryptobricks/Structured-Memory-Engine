'use strict';

/**
 * v8.0 Recall Quality Benchmarking — objective measurement of recall improvements.
 */

const fs = require('fs');
const path = require('path');

function loadBenchmarkSuite(suitePath) {
  return JSON.parse(fs.readFileSync(suitePath, 'utf-8'));
}

function gradeResult(test, recallResults) {
  const top3 = recallResults.slice(0, 3);
  const top3Content = top3.map(r => (r.content || '')).join(' ').toLowerCase();

  let contentHits = 0;
  for (const term of (test.expectedContent || [])) {
    if (top3Content.includes(term.toLowerCase())) contentHits++;
  }
  const contentRate = test.expectedContent?.length > 0
    ? contentHits / test.expectedContent.length : 1;

  let typeHits = 0;
  for (const type of (test.expectedTypes || [])) {
    if (top3.some(r => (r.chunkType || r.chunk_type) === type)) typeHits++;
  }
  const typeRate = test.expectedTypes?.length > 0
    ? typeHits / test.expectedTypes.length : 1;

  const minRelevant = test.minRelevantInTop3 || 0;
  const relevantMet = contentHits >= minRelevant;

  const combined = (contentRate * 0.6 + typeRate * 0.2 + (relevantMet ? 1 : 0) * 0.2);
  if (combined >= 0.8) return { grade: 'PASS', score: combined, contentHits, typeHits };
  if (combined >= 0.4) return { grade: 'PARTIAL', score: combined, contentHits, typeHits };
  return { grade: 'FAIL', score: combined, contentHits, typeHits };
}

async function runBenchmark(db, workspace, suite, opts = {}) {
  const { recall } = require('./recall');
  const results = [];
  for (const test of suite) {
    const recallResults = recall(db, test.query, { limit: 10, workspace });
    const grade = gradeResult(test, recallResults);
    results.push({ id: test.id, query: test.query, ...grade });
  }
  const passed = results.filter(r => r.grade === 'PASS').length;
  const partial = results.filter(r => r.grade === 'PARTIAL').length;
  const failed = results.filter(r => r.grade === 'FAIL').length;
  const overallScore = results.length > 0 ? (passed + partial * 0.5) / results.length * 10 : 0;
  const version = (() => { try { return require('../package.json').version; } catch (_) { return 'unknown'; } })();
  return { version, totalTests: results.length, passed, partial, failed, overallScore, results };
}

module.exports = { runBenchmark, loadBenchmarkSuite, gradeResult };
