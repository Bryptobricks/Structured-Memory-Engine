'use strict';

/**
 * Recall Strategy Orchestrator — deterministic query classifier that picks
 * a per-strategy scoring profile before recall executes.
 *
 * Closes the one gap where myapp's Active Memory LLM sub-agent has a
 * theoretical advantage: query understanding. SME's answer is pure regex +
 * entity detection → zero LLM cost, ~0ms overhead, and the output is a full
 * ranked chunk set under an intent-tuned weight profile rather than a
 * 220-char LLM-generated summary.
 *
 * Strategies → profile names (registered in scoring.js PROFILES):
 *   entity_brief         — "who is X", "tell me about X"
 *   timeline_brief       — date/month/year references
 *   relationship_brief   — "X works with Y", team/collab/manager language
 *   verification_lookup  — "where is this from", source/citation language
 *   quick_context        — fallback (current default recall behavior)
 */

// Order matters: specific patterns checked before general ones.
// relationship_brief before entity_brief so "who is X's manager" → relationship not entity.
// verification_lookup before entity_brief so "where is this from" doesn't get caught by entity.
const STRATEGY_PATTERNS = {
  verification_lookup: {
    pattern: /\b(where\s+(?:is|was)\s+(?:this|that|it)\s+(?:written|said|from)|what('?s|\s+is)\s+the\s+source|which\s+file|exact\s+date|verbatim|cite|citation|quoted)/i,
    requireEntities: false,
    profile: 'verification_lookup',
  },
  timeline_brief: {
    pattern: /\b(january|february|march|april|may|june|july|august|september|october|november|december|last\s+(?:week|month|year)|this\s+(?:week|month)|yesterday|today|tomorrow|\d{4}-\d{2}-\d{2}|20\d{2})\b/i,
    requireEntities: false,
    profile: 'timeline_brief',
  },
  relationship_brief: {
    pattern: /\b(partner|partners|works?\s+with|colleague|colleagues|relationship|married|dating|manager|reports?\s+to|team(?:mate)?|collaborat(?:e|es|ing|ion))\b/i,
    requireEntities: true,
    profile: 'relationship_brief',
  },
  entity_brief: {
    pattern: /\b(who\s+is|who\s+was|tell\s+me\s+about|what\s+do\s+you\s+know\s+about|describe|what('?s|\s+is)\s+\w+\??)/i,
    requireEntities: true,
    profile: 'entity_brief',
  },
};

const DEFAULT_STRATEGY = {
  strategy: 'quick_context',
  reason: 'no pattern match — default',
  profile: null, // null = caller uses existing default (RECALL_PROFILE / CIL_PROFILE)
};

/**
 * Classify a query into a recall strategy.
 *
 * @param {string} query
 * @param {string[]} [detectedEntities=[]] — normalized entity names from the query
 * @returns {{ strategy: string, reason: string, profile: string|null }}
 */
function classifyStrategy(query, detectedEntities = []) {
  if (!query || typeof query !== 'string') return { ...DEFAULT_STRATEGY, reason: 'invalid query' };

  for (const [strategyName, cfg] of Object.entries(STRATEGY_PATTERNS)) {
    if (!cfg.pattern.test(query)) continue;
    if (cfg.requireEntities && (!detectedEntities || detectedEntities.length === 0)) continue;
    return {
      strategy: strategyName,
      reason: `matched ${strategyName} pattern`,
      profile: cfg.profile,
    };
  }

  return { ...DEFAULT_STRATEGY };
}

module.exports = { classifyStrategy, STRATEGY_PATTERNS, DEFAULT_STRATEGY };
