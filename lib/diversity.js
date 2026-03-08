'use strict';

/**
 * v8.0 Result Diversity Enforcement — prevents duplicate/near-duplicate chunks
 * from consuming the context token budget.
 */

const { tokenize, buildIdf, buildTfIdf, cosineSimilarity } = require('./dedup');

function enforceResultDiversity(chunks, opts = {}) {
  const {
    maxPerFile = 3,
    maxPerHeading = 2,
    similarityThreshold = 0.80,
  } = opts;
  if (chunks.length <= 1) return { selected: chunks, filtered: { byFile: 0, byHeading: 0, bySimilarity: 0 } };

  const selected = [];
  const selectedIndices = [];
  const fileCounts = {};
  const headingCounts = {};
  let byFile = 0, byHeading = 0, bySimilarity = 0;

  // Pre-compute TF-IDF vectors for similarity checks
  const allTokens = chunks.map(c => tokenize(c.content || ''));
  const idf = buildIdf(allTokens);
  const vecs = allTokens.map(t => buildTfIdf(t, idf));

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const fileKey = chunk.filePath || chunk.file_path || '';
    const headingKey = `${fileKey}::${chunk.heading || ''}`;

    // File cap
    if ((fileCounts[fileKey] || 0) >= maxPerFile) { byFile++; continue; }
    // Heading cap
    if ((headingCounts[headingKey] || 0) >= maxPerHeading) { byHeading++; continue; }
    // Similarity check against already-selected
    let tooSimilar = false;
    for (const j of selectedIndices) {
      if (cosineSimilarity(vecs[i], vecs[j]) >= similarityThreshold) {
        tooSimilar = true; break;
      }
    }
    if (tooSimilar) { bySimilarity++; continue; }

    selected.push(chunk);
    selectedIndices.push(i);
    fileCounts[fileKey] = (fileCounts[fileKey] || 0) + 1;
    headingCounts[headingKey] = (headingCounts[headingKey] || 0) + 1;
  }

  return {
    selected,
    filtered: { byFile, byHeading, bySimilarity },
    uniqueFiles: Object.keys(fileCounts).length,
    uniqueHeadings: Object.keys(headingCounts).length,
  };
}

module.exports = { enforceResultDiversity };
