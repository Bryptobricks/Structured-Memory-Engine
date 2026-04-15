'use strict';

/**
 * Shared scoring module — single scorer, multiple weight profiles.
 * Used by both recall.js (sme_query) and context.js (sme_context).
 */

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

// ─── F1 Orchestrator strategy profiles ───
// Each strategy is tuned for a specific query intent. Weights shift relative
// emphasis; the entityMention signal (F5) lights up when query entities match.

const ENTITY_BRIEF_PROFILE = {
  fts: 0.20,
  recency: 0.10,
  type: 0.10,
  entity: 0.20,
  entityMention: 0.25,  // heavy weight on mention_count boost
  semantic: 0,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,  // old facts about people/projects still relevant
};

const ENTITY_BRIEF_SEMANTIC_PROFILE = {
  fts: 0.15,
  recency: 0.10,
  type: 0.10,
  entity: 0.15,
  entityMention: 0.20,
  semantic: 0.25,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,
};

const TIMELINE_BRIEF_PROFILE = {
  fts: 0.25,
  recency: 0.40,  // strong recency emphasis; applyTemporalBoost also lifts matching dates
  type: 0.15,
  entity: 0.10,
  semantic: 0,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 60,
};

const TIMELINE_BRIEF_SEMANTIC_PROFILE = {
  fts: 0.15,
  recency: 0.35,
  type: 0.15,
  entity: 0.10,
  semantic: 0.25,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 60,
};

const RELATIONSHIP_BRIEF_PROFILE = {
  fts: 0.15,
  recency: 0.15,
  type: 0.10,
  entity: 0.25,
  entityMention: 0.25,  // co-occurrence bonus drives the "X works with Y" pattern
  semantic: 0,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,
};

const RELATIONSHIP_BRIEF_SEMANTIC_PROFILE = {
  fts: 0.10,
  recency: 0.15,
  type: 0.10,
  entity: 0.20,
  entityMention: 0.20,
  semantic: 0.25,
  confidenceExponent: 1.0,
  recencyHalfLifeDays: 120,
};

const VERIFICATION_LOOKUP_PROFILE = {
  fts: 0.50,  // strong keyword emphasis for exact/verbatim lookups
  recency: 0.15,
  type: 0.10,
  entity: 0.15,
  semantic: 0,
  confidenceExponent: 1.2,
  recencyHalfLifeDays: 180,  // verification doesn't care if the source is old
};

const VERIFICATION_LOOKUP_SEMANTIC_PROFILE = {
  fts: 0.40,
  recency: 0.15,
  type: 0.10,
  entity: 0.10,
  semantic: 0.25,
  confidenceExponent: 1.2,
  recencyHalfLifeDays: 180,
};

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

  // Recency — exponential decay with configurable half-life
  const created = chunk.created_at ? new Date(chunk.created_at).getTime() : 0;
  const daysAgo = Math.max(0, (nowMs - created) / 86400000);
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

  // Entity mention signal — log-scaled mention count + co-occurrence bonus.
  // Requires overrides.queryEntities + overrides.entityIndexMap; silently
  // returns 0 otherwise (no regression for callers that don't provide them).
  const entityMention = (p.entityMention > 0 && p && p.queryEntities && p.entityIndexMap)
    ? entityMentionScore(chunk, p.queryEntities, p.entityIndexMap)
    : 0;

  // Additive sum — shift weights when semantic signal is available
  const useSemantic = p.semantic > 0 && semantic > 0;
  const baseScore = useSemantic
    ? p.fts * (chunk._normalizedFts || 0) +
      p.semantic * semantic +
      p.recency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.entity * entityMatch +
      (p.entityMention || 0) * entityMention
    : (p.fts + p.semantic) * (chunk._normalizedFts || 0) +
      p.recency * recency +
      p.type * (typeBonus + 0.15) / 0.30 +
      p.entity * entityMatch +
      (p.entityMention || 0) * entityMention;

  const metadataPenalty = metadataDensityPenalty(chunk.content || '');
  return baseScore * Math.pow(confidence, p.confidenceExponent) * fileWeight * metadataPenalty;
}

/**
 * Entity Mention Score — log-scaled mention_count boost + co-occurrence bonus.
 *
 * Each query entity found in the chunk contributes log2(mentionCount+1)/6,
 * capped at 1.0. Co-occurring entities (where the chunk mentions both the
 * query entity AND another entity known to co-occur with it) add a bonus
 * proportional to the co-occurrence count, capped at 0.15 per pair.
 *
 * @param {object} chunk — must have chunk.entities as a JSON string array
 * @param {string[]} queryEntities — normalized lowercase entity names from the query
 * @param {Map<string, {mentionCount:number, coEntities:object}>} entityIndexMap
 * @returns {number} 0..1
 */
function entityMentionScore(chunk, queryEntities, entityIndexMap) {
  if (!queryEntities || queryEntities.length === 0) return 0;
  if (!entityIndexMap || entityIndexMap.size === 0) return 0;

  let chunkEntities;
  try {
    chunkEntities = JSON.parse(chunk.entities || '[]').map(e => String(e).toLowerCase().replace(/^@/, ''));
  } catch (_) {
    return 0;
  }
  if (chunkEntities.length === 0) return 0;

  let score = 0;
  for (const qEntity of queryEntities) {
    if (!chunkEntities.includes(qEntity)) continue;
    const entry = entityIndexMap.get(qEntity);
    if (!entry) continue;
    // Log-scaled mention boost — saturates around mention_count ~64 (2^6 - 1)
    score += Math.min(1.0, Math.log2(entry.mentionCount + 1) / 6);
    // Co-occurrence bonus — reward chunks that surface related entities
    for (const chunkEntity of chunkEntities) {
      if (chunkEntity === qEntity) continue;
      const coCount = (entry.coEntities && entry.coEntities[chunkEntity]) || 0;
      if (coCount > 0) score += Math.min(0.15, coCount / 20);
    }
  }
  return Math.min(1.0, score);
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
  // F1 Orchestrator strategies
  entity_brief: ENTITY_BRIEF_PROFILE,
  'entity_brief-semantic': ENTITY_BRIEF_SEMANTIC_PROFILE,
  timeline_brief: TIMELINE_BRIEF_PROFILE,
  'timeline_brief-semantic': TIMELINE_BRIEF_SEMANTIC_PROFILE,
  relationship_brief: RELATIONSHIP_BRIEF_PROFILE,
  'relationship_brief-semantic': RELATIONSHIP_BRIEF_SEMANTIC_PROFILE,
  verification_lookup: VERIFICATION_LOOKUP_PROFILE,
  'verification_lookup-semantic': VERIFICATION_LOOKUP_SEMANTIC_PROFILE,
  quick_context: RECALL_PROFILE,  // alias for default
  'quick_context-semantic': RECALL_SEMANTIC_PROFILE,
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
  entityMentionScore,
  normalizeFtsScores,
};
const { metadataDensityPenalty } = require('./noise');
