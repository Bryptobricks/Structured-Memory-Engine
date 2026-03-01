'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append a recall event to the JSONL log.
 * Each line is a self-contained JSON object.
 *
 * @param {string} workspace - workspace path
 * @param {object} event
 * @param {string} event.query - the user's message (truncated to 200 chars)
 * @param {string[]} event.queryTerms - extracted terms after stop word filtering
 * @param {number} event.chunksReturned - number of chunks after all filtering
 * @param {number} event.chunksDropped - number dropped by exclusion + score filters
 * @param {number} event.excludedByPattern - chunks dropped specifically by excludeFromRecall
 * @param {number} event.tokenEstimate - estimated tokens of injected context
 * @param {Array} event.chunks - array of { filePath, cilScore, chunkType, content }
 * @param {number} event.durationMs - time taken for the full context() call
 */
function logRecall(workspace, event) {
  const logPath = path.join(workspace, '.memory', 'recall-log.jsonl');

  const entry = {
    ts: new Date().toISOString(),
    query: (event.query || '').slice(0, 200),
    terms: event.queryTerms || [],
    returned: event.chunksReturned || 0,
    dropped: event.chunksDropped || 0,
    excluded: event.excludedByPattern || 0,
    tokens: event.tokenEstimate || 0,
    durationMs: event.durationMs || 0,
    chunks: (event.chunks || []).map(c => ({
      file: c.filePath,
      score: parseFloat((c.cilScore || 0).toFixed(4)),
      type: c.chunkType,
      preview: (c.content || '').slice(0, 80),
    })),
  };

  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (_) {
    // Non-fatal — don't crash recall pipeline for logging failure
  }
}

/**
 * Read and summarize the recall log.
 * Returns aggregate stats for the last N entries.
 */
function summarizeLog(workspace, { last = 100 } = {}) {
  const logPath = path.join(workspace, '.memory', 'recall-log.jsonl');
  try {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entries = lines.slice(-last).map(l => JSON.parse(l));

    const total = entries.length;
    const empty = entries.filter(e => e.returned === 0).length;
    const avgChunks = entries.reduce((s, e) => s + e.returned, 0) / total;
    const avgTokens = entries.reduce((s, e) => s + e.tokens, 0) / total;
    const avgDuration = entries.reduce((s, e) => s + e.durationMs, 0) / total;
    const totalExcluded = entries.reduce((s, e) => s + (e.excluded || 0), 0);

    // File frequency — which files appear most in recalled context
    const fileCounts = {};
    for (const e of entries) {
      for (const c of e.chunks) {
        fileCounts[c.file] = (fileCounts[c.file] || 0) + 1;
      }
    }
    const topFiles = Object.entries(fileCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // Score distribution
    const allScores = entries.flatMap(e => e.chunks.map(c => c.score));
    const avgScore = allScores.length > 0
      ? allScores.reduce((s, v) => s + v, 0) / allScores.length
      : 0;
    const minScore = allScores.length > 0 ? Math.min(...allScores) : 0;
    const maxScore = allScores.length > 0 ? Math.max(...allScores) : 0;

    return {
      total,
      emptyRecalls: empty,
      emptyRate: (empty / total * 100).toFixed(1) + '%',
      avgChunks: parseFloat(avgChunks.toFixed(1)),
      avgTokens: Math.round(avgTokens),
      avgDurationMs: Math.round(avgDuration),
      totalExcludedByPattern: totalExcluded,
      scoreDistribution: {
        avg: parseFloat(avgScore.toFixed(4)),
        min: parseFloat(minScore.toFixed(4)),
        max: parseFloat(maxScore.toFixed(4)),
      },
      topFiles,
    };
  } catch (_) {
    return { error: 'No recall log found' };
  }
}

/**
 * Rotate the recall log if it exceeds maxLines.
 * Keeps the most recent keepLines entries.
 */
function rotateLog(workspace, { maxLines = 10000, keepLines = 5000 } = {}) {
  const logPath = path.join(workspace, '.memory', 'recall-log.jsonl');
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length > maxLines) {
      fs.writeFileSync(logPath, lines.slice(-keepLines).join('\n') + '\n');
      return { rotated: true, before: lines.length, after: keepLines };
    }
    return { rotated: false, lines: lines.length };
  } catch (_) {
    return { error: 'No log file' };
  }
}

module.exports = { logRecall, summarizeLog, rotateLog };
