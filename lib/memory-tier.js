'use strict';

/**
 * Memory Tiering + Recall-Stat Auto-Promotion (F2).
 *
 * Classifies chunks into four tiers at ingest time and multiplies final
 * scores by per-tier weights. Frequently-recalled chunks promote upward
 * automatically — the signal (recall activity) and the action (tier upgrade)
 * are co-located in the same system with zero latency between them.
 *
 * Tiers (highest → lowest):
 *   durable_personal  — user facts/preferences, always preserved, 1.0x score
 *   durable_project   — project decisions/milestones, 1.0x
 *   working_reference — everyday context, 0.75x (default for unclassified)
 *   ops_runbook       — operational metadata (keys, urls, commands), 0.45x
 *
 * Promotion: ops_runbook → working_reference → durable_project when a
 * chunk crosses recall_count + unique_query_count thresholds.
 */

const TIER_MULTIPLIERS = {
  durable_personal: 1.0,
  durable_project: 1.0,
  working_reference: 0.75,
  ops_runbook: 0.45,
};

// Fast path for chunks whose chunk_type already implies a tier.
// action_item stays durable because it represents actionable commitments.
const TYPE_FAST_PATHS = {
  preference: 'durable_personal',
  confirmed: 'durable_personal',
  decision: 'durable_project',
  action_item: 'durable_project',
};

const OPS_RUNBOOK_RE = /\b(access[.\s_-]?token|webhook|api[.\s_-]?key|gateway\s*restart|chmod|crontab|localhost:\d{4,5}|npm\s+install|config\.json|\.env\b|curl\s+-[XGLPOIvk]|docker\s+run|systemctl|brew\s+install)\b/i;
const PERSONAL_RE = /\b(birthday|DOB|partner|relationship|prefers?|likes?|dislikes?|goal|health|bloodwork|medical|medication|allergy|allergies|anniversary)\b/i;
const PROJECT_RE = /(\b(shipped|deployed|decided|architecture|milestone|launched|release\s+notes)\b|\bversion\s*\d|\bv\d+\.\d+|\bPR\s*#?\d+|\bcommit\s+[a-f0-9]{6,})/i;

/**
 * Classify a chunk into a memory tier based on its type and content.
 *
 * @param {object} chunk — must have { chunk_type?, content? }
 * @returns {string} tier name
 */
function classifyTier(chunk) {
  if (!chunk) return 'working_reference';

  // Fast path: chunk_type alone is enough for some tiers
  if (chunk.chunk_type && TYPE_FAST_PATHS[chunk.chunk_type]) {
    return TYPE_FAST_PATHS[chunk.chunk_type];
  }

  const content = chunk.content || '';
  if (!content) return 'working_reference';

  // ops_runbook wins over personal/project — operational content is noisy
  // and we want it actively suppressed in normal recall.
  if (OPS_RUNBOOK_RE.test(content)) return 'ops_runbook';
  if (PERSONAL_RE.test(content)) return 'durable_personal';
  if (PROJECT_RE.test(content)) return 'durable_project';

  return 'working_reference';
}

/**
 * Promotion rules — fire inline after recall stat updates.
 * A chunk promotes when it has BOTH minRecall total recalls AND minUnique
 * distinct queries, proving it matters to more than one kind of question.
 */
const PROMOTION_RULES = [
  { from: 'ops_runbook', to: 'working_reference', minRecall: 10, minUnique: 5 },
  { from: 'working_reference', to: 'durable_project', minRecall: 5, minUnique: 3 },
];

/**
 * Check whether a chunk has crossed a promotion threshold.
 * @returns {string|null} new tier name if promotion applies, else null
 */
function checkPromotion(chunk) {
  if (!chunk || !chunk.memory_tier) return null;
  for (const rule of PROMOTION_RULES) {
    if (chunk.memory_tier !== rule.from) continue;
    if ((chunk.recall_count || 0) < rule.minRecall) continue;
    if ((chunk.unique_query_count || 0) < rule.minUnique) continue;
    return rule.to;
  }
  return null;
}

/**
 * Apply the tier multiplier to a raw score.
 * Unknown tiers fall back to working_reference (0.75x).
 */
function applyTierMultiplier(score, tier) {
  return score * (TIER_MULTIPLIERS[tier] != null ? TIER_MULTIPLIERS[tier] : TIER_MULTIPLIERS.working_reference);
}

module.exports = {
  classifyTier,
  checkPromotion,
  applyTierMultiplier,
  TIER_MULTIPLIERS,
  PROMOTION_RULES,
  TYPE_FAST_PATHS,
};
