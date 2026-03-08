'use strict';

/**
 * v7.4 Temporal Freshness — detect stale relative time references in chunks.
 * "today" from 3 weeks ago should not be presented as current.
 */

const RELATIVE_TERMS = [
  { pattern: /\btoday\b/i, label: 'today', maxAgeDays: 0 },
  { pattern: /\btonight\b/i, label: 'tonight', maxAgeDays: 0 },
  { pattern: /\bthis morning\b/i, label: 'this morning', maxAgeDays: 0 },
  { pattern: /\bthis afternoon\b/i, label: 'this afternoon', maxAgeDays: 0 },
  { pattern: /\bright now\b/i, label: 'right now', maxAgeDays: 0 },
  { pattern: /\bjust now\b/i, label: 'just now', maxAgeDays: 0 },
  { pattern: /\bat the moment\b/i, label: 'at the moment', maxAgeDays: 0 },
  { pattern: /\bcurrently\b/i, label: 'currently', maxAgeDays: 0 },
  { pattern: /\bfor now\b/i, label: 'for now', maxAgeDays: 0 },
  { pattern: /\btemporar(il)?y\b/i, label: 'temporarily', maxAgeDays: 1 },
  { pattern: /\byesterday\b/i, label: 'yesterday', maxAgeDays: 1 },
];

/**
 * Extract date from a file path like memory/2026-03-05.md
 */
function extractDateFromPath(filePath) {
  const m = filePath && filePath.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Get the recorded date for a chunk — prefer file path date, fall back to created_at.
 */
function getRecordedDate(chunk) {
  const pathDate = extractDateFromPath(chunk.file_path);
  if (pathDate) return pathDate;
  if (chunk.created_at) return chunk.created_at.split('T')[0];
  return null;
}

/**
 * Check if a chunk contains stale relative time references.
 *
 * @param {string} content - chunk content
 * @param {string} recordedDate - YYYY-MM-DD when the chunk was recorded
 * @param {string} [todayStr] - override for today's date (testing)
 * @returns {{ isStale: boolean, recordedDate: string|null, relativeTerms: string[] }}
 */
function isStaleRelative(content, recordedDate, todayStr) {
  const today = todayStr || new Date().toISOString().split('T')[0];
  const result = { isStale: false, recordedDate, relativeTerms: [] };

  if (!content || !recordedDate) return result;

  const recordedMs = new Date(recordedDate).getTime();
  const todayMs = new Date(today).getTime();
  const ageDays = Math.floor((todayMs - recordedMs) / 86400000);

  for (const { pattern, label, maxAgeDays } of RELATIVE_TERMS) {
    if (pattern.test(content)) {
      result.relativeTerms.push(label);
      if (ageDays > maxAgeDays) {
        result.isStale = true;
      }
    }
  }

  return result;
}

/**
 * Stale relative penalty multiplier for scoring.
 * Returns 1.0 (no penalty) or 0.35 (stale).
 */
const STALE_RELATIVE_PENALTY = 0.35;

function staleRelativePenalty(chunk, todayStr) {
  const recordedDate = getRecordedDate(chunk);
  const check = isStaleRelative(chunk.content, recordedDate, todayStr);
  return check.isStale ? STALE_RELATIVE_PENALTY : 1.0;
}

/**
 * Annotate content with recorded date context for stale-relative chunks.
 */
function annotateStaleRelative(content, recordedDate) {
  return `(Recorded on ${recordedDate}; relative dates refer to that date) ${content}`;
}

module.exports = {
  isStaleRelative,
  staleRelativePenalty,
  annotateStaleRelative,
  getRecordedDate,
  extractDateFromPath,
  STALE_RELATIVE_PENALTY,
  RELATIVE_TERMS,
};
