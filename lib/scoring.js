'use strict';

/**
 * Shared scoring module — single scorer, multiple weight profiles.
 * Used by both recall.js (sme_query) and context.js (sme_context).
 */

const TYPE_BONUS = {
  confirmed: 0.15,
  decision: 0.12,
  preference: 0.10,
  fact: 0.08,
  opinion: 0.04,
  inferred: 0.0,
  outdated: -0.15,
  action_item: 0.10,
  raw: 0.0,
};

// Weight profiles — all weights sum to 1.0 (excluding semantic when absent)
const RECALL_PROFILE = {
  fts: 0.50,
  recency: 0.25,
  type: 0.10,
  fileWeight: 0.10,
  entity: 0.05,
  semantic: 0,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 90,
};

const CIL_PROFILE = {
  fts: 0.35,
  recency: 0.30,
  type: 0.15,
  fileWeight: 0.10,
  entity: 0.10,
  semantic: 0,
  confidenceExponent: 1.5,
  recencyHalfLifeDays: 14,
};

const CIL_SEMANTIC_PROFILE = {
  fts: 0.20,
  recency: 0.20,
  type: 0.10,
  fileWeight: 0.10,
  entity: 0.10,
  semantic: 0.30,
  confidenceExponent: 1.5,
  recencyHalfLifeDays: 14,
};

/**
 * Score a single chunk using a weighted additive model.
 *
 * @param {object} chunk — must have: confidence, created_at, chunk_type, file_weight.
 *   Optional enrichments: _normalizedFts, _entityMatch, _semanticSim.
 * @param {number} nowMs — Date.now()
 * @param {object} profile — weight profile (RECALL_PROFILE, CIL_PROFILE, etc.)
 * @param {object} [overrides] — per-call overrides (e.g. { recencyHalfLifeDays: 60 })
 * @returns {number} composite score (higher = better)
 */
function score(chunk, nowMs, profile, overrides) {
  const p = overrides ? { ...profile, ...overrides } : profile;
  const confidence = chunk.confidence != null ? chunk.confidence : 1.0;

  // Recency — exponential decay with configurable half-life
  const created = chunk.created_at ? new Date(chunk.created_at).getTime() : 0;
  const daysAgo = Math.max(0, (nowMs - created) / 86400000);
  const recency = Math.exp(-0.693 * daysAgo / p.recencyHalfLifeDays);

  // Type priority
  const typeBonus = TYPE_BONUS[chunk.chunk_type] || 0;

  // File weight (normalized to 0-1 range, 1.5 is max)
  const fileWeight = chunk.file_weight || 1.0;

  // Entity match bonus
  const entityMatch = chunk._entityMatch ? 1 : 0;

  // Semantic similarity (0 when embeddings not available or not in profile)
  const semantic = chunk._semanticSim || 0;

  // Weighted sum — shift weights when semantic signal is available
  const useSemantic = p.semantic > 0 && semantic > 0;
  const baseScore = useSemantic
    ? p.fts * (chunk._normalizedFts || 0) +
      p.semantic * semantic +
      p.recency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.fileWeight * (fileWeight / 1.5) +
      p.entity * entityMatch
    : (p.fts + p.semantic) * (chunk._normalizedFts || 0) +
      p.recency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.fileWeight * (fileWeight / 1.5) +
      p.entity * entityMatch;

  return baseScore * Math.pow(confidence, p.confidenceExponent);
}

/**
 * Normalize FTS5 rank values across a set of results to 0-1 range.
 * Mutates results in place, setting _normalizedFts on each.
 */
function normalizeFtsScores(results) {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0]._normalizedFts = 1.0;
    return;
  }
  const ranks = results.map(r => r.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const range = maxRank - minRank || 1;
  for (const r of results) {
    r._normalizedFts = 0.3 + 0.7 * (maxRank - r.rank) / range;
  }
}

module.exports = {
  TYPE_BONUS,
  RECALL_PROFILE,
  CIL_PROFILE,
  CIL_SEMANTIC_PROFILE,
  score,
  normalizeFtsScores,
};
