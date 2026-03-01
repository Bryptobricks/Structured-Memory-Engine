#!/usr/bin/env node
'use strict';

const { create } = require('../lib/api.js');

const TEST_QUERIES = [
  {
    id: 'Q1',
    label: 'Purchases',
    query: 'What purchases am I still waiting on?',
    expectedFiles: ['MEMORY.md', 'open-loops.md'],
    expectedTerms: ['bedroom', 'smartwings', 'blinds', 'shipping', 'ordered', 'arrived'],
    antiTerms: ['NON-NEGOTIABLE', 'HARD RULES', 'Account Rules'],
    minChunks: 5,
    minRelevant: 4,
  },
  {
    id: 'Q2',
    label: 'Wednesday',
    query: 'What did I accomplish last Wednesday?',
    expectedFiles: [],
    expectedTerms: [],
    antiTerms: [],
    minChunks: 5,
    minRelevant: 4,
  },
  {
    id: 'Q3',
    label: 'March',
    query: 'What is coming up for me in March?',
    expectedFiles: ['MEMORY.md'],
    expectedTerms: ['offsite', 'march', 'cycle', 'reminder'],
    antiTerms: [],
    minChunks: 4,
    minRelevant: 3,
  },
  {
    id: 'Q4',
    label: 'Focus',
    query: 'What should I be focused on right now?',
    expectedFiles: ['open-loops.md'],
    expectedTerms: ['loop', 'action', 'priority', 'blocked', 'pending'],
    antiTerms: [],
    minChunks: 5,
    minRelevant: 3,
  },
  {
    id: 'Q5',
    label: 'Weight',
    query: 'How has my weight changed since starting retatrutide?',
    expectedFiles: ['MEMORY.md'],
    expectedTerms: ['retatrutide', 'weight', '215', '197', 'peptide'],
    antiTerms: [],
    minChunks: 6,
    minRelevant: 5,
  },
  {
    id: 'Q6',
    label: 'Equities',
    query: 'What did I decide about my equities strategy?',
    expectedFiles: ['MEMORY.md'],
    expectedTerms: ['equities', 'NVDA', 'TSM', 'hyperliquid', 'perps', 'framework'],
    antiTerms: [],
    minChunks: 6,
    minRelevant: 5,
  },
];

async function runTests(workspace, opts = {}) {
  const { verbose = false, singleQuery = null } = opts;
  const api = create({ workspace });
  const results = [];
  const queries = singleQuery
    ? TEST_QUERIES.filter(t => t.query.toLowerCase().includes(singleQuery.toLowerCase()) || t.id === singleQuery || t.label.toLowerCase() === singleQuery.toLowerCase())
    : TEST_QUERIES;

  if (queries.length === 0) {
    console.error('No matching query found for: ' + singleQuery);
    api.close();
    process.exit(1);
  }

  for (const test of queries) {
    const result = await api.context(test.query);
    const chunks = result.chunks || [];

    // Build combined text for term matching
    const allText = chunks.map(c =>
      ((c.content || '') + ' ' + (c.heading || '')).toLowerCase()
    ).join(' ');

    const termsFound = test.expectedTerms.filter(t => allText.includes(t.toLowerCase()));
    const antiFound = test.antiTerms.filter(t => allText.includes(t.toLowerCase()));
    const filesFound = test.expectedFiles.filter(f =>
      chunks.some(c => (c.filePath || '').includes(f))
    );

    // Auto-score heuristic
    let score = 5;
    score += Math.min(2, (chunks.length >= test.minChunks) ? 2 : (chunks.length / Math.max(1, test.minChunks)) * 2);
    score += Math.min(2, (termsFound.length / Math.max(1, test.expectedTerms.length)) * 2);
    score -= antiFound.length * 1.5;
    score += filesFound.length * 0.5;
    score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));

    const entry = {
      ...test,
      chunks: chunks.length,
      score,
      termsFound,
      antiFound,
      filesFound,
      pass: chunks.length >= test.minChunks && antiFound.length === 0,
      rawChunks: chunks,
    };
    results.push(entry);

    // Output
    const icon = score >= 8 ? '\u{1F7E2}' : score >= 6 ? '\u{1F7E1}' : '\u{1F534}';
    console.log(`${icon} ${test.id} ${test.label.padEnd(12)} ${score.toFixed(1)}/10  (${chunks.length} chunks)`);

    if (verbose) {
      for (const c of chunks.slice(0, 8)) {
        const fp = (c.filePath || '?').split('/').pop();
        const heading = (c.heading || '').substring(0, 50);
        const s = (c.cilScore || 0).toFixed(3);
        const flags = [];
        if (c._rescued) flags.push('R');
        if (c._injected) flags.push('I');
        if (c._rulePenalty) flags.push('P' + c._rulePenalty.toFixed(1));
        const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
        console.log(`    [${s}]${flagStr} ${fp.padEnd(35)} | ${heading}`);
      }
    }

    if (antiFound.length > 0) {
      console.log(`    \u26A0\uFE0F  Anti-terms found: ${antiFound.join(', ')}`);
    }
  }

  // Summary
  console.log('\n' + '\u2500'.repeat(50));
  const avg = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const passed = results.filter(r => r.pass).length;
  console.log(`Average: ${avg.toFixed(1)}/10 | Passed: ${passed}/${results.length}`);

  api.close();
  process.exit(passed === results.length ? 0 : 1);
}

// CLI
const args = process.argv.slice(2);
const workspace = args.find(a => !a.startsWith('-')) || '.';
const verbose = args.includes('--verbose') || args.includes('-v');
const queryIdx = args.indexOf('--query');
const singleQuery = queryIdx >= 0 ? args[queryIdx + 1] : null;

runTests(workspace, { verbose, singleQuery });
