'use strict';

/**
 * Shared scoring module — single scorer, multiple weight profiles.
 * Used by both recall.js (sme_query) and context.js (sme_context).
 */

const { staleRelativePenalty } = require('./temporal-freshness');

const TYPE_BONUS = {
  confirmed: 0.25,
  decision: 0.20,
  preference: 0.18,
  fact: 0.12,
  opinion: 0.06,
  inferred: 0.0,
  outdated: -0.20,
  action_item: 0.15,
  raw: 0.0,
};

// Weight profiles — additive weights sum to 1.0 (excluding semantic when absent).
// file_weight is applied multiplicatively (not in this sum) — see score().
const RECALL_PROFILE = {
  fts: 0.55,
  recency: 0.25,
  type: 0.10,
  entity: 0.10,
  semantic: 0,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 90,
};

const RECALL_SEMANTIC_PROFILE = {
  fts: 0.30,
  recency: 0.20,
  type: 0.10,
  entity: 0.10,
  semantic: 0.30,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 90,
};

const CIL_PROFILE = {
  fts: 0.35,
  recency: 0.35,
  type: 0.20,
  entity: 0.10,
  semantic: 0,
  confidenceExponent: 1.5,
  recencyHalfLifeDays: 14,
};

const CIL_SEMANTIC_PROFILE = {
  fts: 0.20,
  recency: 0.25,
  type: 0.10,
  entity: 0.10,
  semantic: 0.35,
  confidenceExponent: 1.5,
  recencyHalfLifeDays: 14,
};

const ASSISTANT_PROFILE = {
  fts: 0.40,
  recency: 0.30,
  type: 0.15,
  entity: 0.15,
  semantic: 0,
  confidenceExponent: 1.2,
  recencyHalfLifeDays: 30,
};

const ASSISTANT_SEMANTIC_PROFILE = {
  fts: 0.20,
  recency: 0.25,
  type: 0.10,
  entity: 0.10,
  semantic: 0.35,
  confidenceExponent: 1.2,
  recencyHalfLifeDays: 30,
};

// --- Operational noise penalty (Item 5) ---
const OPS_NOISE_RE = /\b(run:|script|cron|pipeline|phase\s+\d+|auto-indexed|worker|webhook|endpoint|API|config(?:uration)?|token|port\b|sub-agent|session started|compaction|heartbeat|spawned|restart)/i;
const NOISE_EXEMPT_TYPES = new Set(['decision', 'preference', 'confirmed']);

function opsNoisePenalty(chunk, nowMs) {
  if (!chunk.content || !OPS_NOISE_RE.test(chunk.content)) return 1.0;
  if (NOISE_EXEMPT_TYPES.has(chunk.chunk_type)) return 1.0;

  const created = chunk.created_at ? new Date(chunk.created_at).getTime() : 0;
  const daysAgo = Math.max(0, (nowMs - created) / 86400000);

  if (daysAgo <= 1) return 1.0;
  if (daysAgo <= 3) return 0.7;
  if (daysAgo <= 7) return 0.4;
  return 0.2;
}

/**
 * Boost recent daily memory files dynamically based on age.
 * Uses Math.max so config-set weights aren't overridden if already higher.
 */
function getDynamicFileWeight(filePath, baseWeight, nowMs) {
  const dateMatch = filePath && filePath.match(/memory\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (dateMatch) {
    const fileDate = new Date(dateMatch[1]).getTime();
    const daysAgo = (nowMs - fileDate) / 86400000;
    if (daysAgo <= 1) return Math.max(baseWeight, 2.5);
    if (daysAgo <= 3) return Math.max(baseWeight, 2.0);
    if (daysAgo <= 7) return Math.max(baseWeight, 1.5);
  }
  return baseWeight;
}

/**
 * Score a single chunk using a weighted additive model with multiplicative file weight.
 *
 * Additive signals (FTS, recency, type, entity, semantic) are summed with profile weights.
 * file_weight and confidence are applied multiplicatively — they scale the entire score,
 * so a 0.3x build-artifact penalty can't be overwhelmed by a strong FTS match.
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

  // Recency — use freshest available timestamp (v8: content_updated_at support)
  const createdMs = chunk.created_at ? new Date(chunk.created_at).getTime() : 0;
  const updatedMs = chunk.content_updated_at ? new Date(chunk.content_updated_at).getTime() : 0;
  const accessedMs = chunk.last_accessed ? new Date(chunk.last_accessed).getTime() : 0;
  const effectiveMs = Math.max(createdMs, updatedMs, accessedMs);
  const daysAgo = Math.max(0, (nowMs - effectiveMs) / 86400000);
  const recency = Math.exp(-0.693 * daysAgo / p.recencyHalfLifeDays);

  // Type priority
  const typeBonus = TYPE_BONUS[chunk.chunk_type] || 0;

  // File weight — applied multiplicatively (not in additive sum)
  // Dynamic boost for recent daily memory files
  const baseFileWeight = chunk.file_weight || 1.0;
  const fileWeight = getDynamicFileWeight(chunk.file_path, baseFileWeight, nowMs);

  // Entity match bonus
  const entityMatch = chunk._entityMatch ? 1 : 0;

  // Semantic similarity (0 when embeddings not available or not in profile)
  const semantic = chunk._semanticSim || 0;

  // Additive sum — shift weights when semantic signal is available
  const useSemantic = p.semantic > 0 && semantic > 0;
  const baseScore = useSemantic
    ? p.fts * (chunk._normalizedFts || 0) +
      p.semantic * semantic +
      p.recency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.entity * entityMatch
    : (p.fts + p.semantic) * (chunk._normalizedFts || 0) +
      p.recency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.entity * entityMatch;

  // Multiplicative penalties: stale relative dates + operational noise
  const stalePenalty = staleRelativePenalty(chunk);
  const noisePenalty = opsNoisePenalty(chunk, nowMs);

  // Value scoring multiplier (v8: wire value_score into live recall)
  const vs = chunk.value_score;
  const valueScoringEnabled = p.valueScoringEnabled !== false;
  const valueMultiplier = (valueScoringEnabled && vs != null) ? (0.7 + vs * 0.6) : 1.0;
  // Maps: value_score 0→0.7x, 0.5→1.0x, 1.0→1.3x

  // Synonym-only match penalty (v8)
  const synonymPenalty = chunk._synonymMatch ? (p.synonymPenalty || 0.85) : 1.0;

  return baseScore * Math.pow(confidence, p.confidenceExponent) * fileWeight * stalePenalty * noisePenalty * valueMultiplier * synonymPenalty;
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
  // Percentile-based normalization: use p10/p90 to resist outlier distortion
  const ranks = results.map(r => r.rank);
  const sorted = [...ranks].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const range = p90 - p10 || 1;
  for (const r of results) {
    const clamped = Math.max(p10, Math.min(p90, r.rank));
    r._normalizedFts = 0.3 + 0.7 * (p90 - clamped) / range;
  }
}

const PROFILES = {
  default: RECALL_PROFILE,
  'default-semantic': RECALL_SEMANTIC_PROFILE,
  cil: CIL_PROFILE,
  'cil-semantic': CIL_SEMANTIC_PROFILE,
  assistant: ASSISTANT_PROFILE,
  'assistant-semantic': ASSISTANT_SEMANTIC_PROFILE,
};

/**
 * Resolve a profile by name, with optional semantic variant.
 * @param {string} name — 'default', 'assistant', or 'cil'
 * @param {boolean} semantic — if true, return the semantic variant
 * @returns {object} profile
 */
function resolveProfile(name, semantic = false) {
  const key = semantic ? `${name}-semantic` : name;
  return PROFILES[key] || (semantic ? RECALL_SEMANTIC_PROFILE : RECALL_PROFILE);
}

module.exports = {
  TYPE_BONUS,
  RECALL_PROFILE,
  RECALL_SEMANTIC_PROFILE,
  CIL_PROFILE,
  CIL_SEMANTIC_PROFILE,
  ASSISTANT_PROFILE,
  ASSISTANT_SEMANTIC_PROFILE,
  PROFILES,
  resolveProfile,
  getDynamicFileWeight,
  score,
  normalizeFtsScores,
  opsNoisePenalty,
  OPS_NOISE_RE,
  NOISE_EXEMPT_TYPES,
};
