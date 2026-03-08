'use strict';

/**
 * v8.0 Automated Memory Promotion — elevates high-value daily memories
 * to MEMORY.md where they persist without recency decay.
 */

const { tokenize, buildIdf, buildTfIdf, cosineSimilarity } = require('./dedup');

function findPromotionCandidates(db, workspace, opts = {}) {
  const { minValueScore = 0.70, maxCandidates = 20, dedupThreshold = 0.75, reviewThreshold = 0.50 } = opts;

  // Core chunks from daily memory files only
  const candidates = db.prepare(`
    SELECT * FROM chunks
    WHERE file_path LIKE 'memory/____-__-__.md'
    AND stale = 0
    AND value_label = 'core'
    AND chunk_type IN ('fact', 'decision', 'preference', 'confirmed')
    AND value_score >= ?
    ORDER BY value_score DESC
    LIMIT ?
  `).all(minValueScore, maxCandidates * 3);

  // Load MEMORY.md chunks for dedup
  const memoryChunks = db.prepare(`SELECT * FROM chunks WHERE file_path = 'MEMORY.md'`).all();

  if (memoryChunks.length === 0) {
    return {
      autoPromote: candidates.slice(0, maxCandidates),
      reviewNeeded: [],
      skipped: [],
    };
  }

  // TF-IDF similarity check against MEMORY.md
  const allDocs = [...memoryChunks, ...candidates];
  const allTokens = allDocs.map(c => tokenize(c.content || ''));
  const idf = buildIdf(allTokens);

  const memVecs = memoryChunks.map((_, i) => buildTfIdf(allTokens[i], idf));

  const autoPromote = [], reviewNeeded = [], skipped = [];

  for (let i = 0; i < candidates.length; i++) {
    if (autoPromote.length >= maxCandidates) break;
    const candVec = buildTfIdf(allTokens[memoryChunks.length + i], idf);

    let maxSim = 0, closestContent = '';
    for (let j = 0; j < memVecs.length; j++) {
      const sim = cosineSimilarity(candVec, memVecs[j]);
      if (sim > maxSim) { maxSim = sim; closestContent = memoryChunks[j].content; }
    }

    if (maxSim >= dedupThreshold) {
      skipped.push({ ...candidates[i], reason: 'already_in_memory', similarity: maxSim });
    } else if (maxSim >= reviewThreshold) {
      reviewNeeded.push({ ...candidates[i], similarTo: closestContent, similarity: maxSim });
    } else {
      autoPromote.push(candidates[i]);
    }
  }

  return { autoPromote, reviewNeeded, skipped };
}

function generatePromotionReport(result) {
  let report = `## Promotion Candidates\n\n`;
  report += `Auto-promote: ${result.autoPromote.length}\n`;
  report += `Needs review: ${result.reviewNeeded.length}\n`;
  report += `Skipped (already in MEMORY.md): ${result.skipped.length}\n\n`;

  if (result.autoPromote.length > 0) {
    report += `### Auto-promote\n`;
    for (const c of result.autoPromote) {
      report += `- [${c.chunk_type}] ${c.content.slice(0, 120)}${c.content.length > 120 ? '...' : ''}\n`;
      report += `  ↳ ${c.file_path} (value: ${(c.value_score || 0).toFixed(2)})\n`;
    }
    report += '\n';
  }

  if (result.reviewNeeded.length > 0) {
    report += `### Needs Review\n`;
    for (const c of result.reviewNeeded) {
      report += `- [${c.chunk_type}] ${c.content.slice(0, 120)}${c.content.length > 120 ? '...' : ''}\n`;
      report += `  ↳ Similar to: ${(c.similarTo || '').slice(0, 80)} (sim: ${(c.similarity || 0).toFixed(2)})\n`;
    }
    report += '\n';
  }

  return report;
}

module.exports = { findPromotionCandidates, generatePromotionReport };
