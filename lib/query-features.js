'use strict';

/**
 * Shared query feature functions used by both context.js (CIL) and recall.js (sme_query).
 * Extracted to avoid circular dependency between recall.js and context.js.
 */

/**
 * Detect query intent for parameter adjustments.
 * Returns { intent, maxChunks, minCilScore, typeBoosts } or null.
 */
function detectQueryIntent(message) {
  // Aggregation: "what are all my...", "list everything...", "summarize...", "overview of..."
  if (/\b(all\s+my|everything|every\s+|list\s+(all|every)|summarize|summary|overview)\b/i.test(message)) {
    return { intent: 'aggregation', maxChunks: 15, minCilScore: 0.10, typeBoosts: null };
  }

  // Reasoning: "why did I...", "what was the reason...", "how did I decide..."
  if (/\b(why\s+did|what\s+was\s+the\s+reason|how\s+did\s+(I|we)\s+decide|reasoning\s+behind|rationale)\b/i.test(message)) {
    return { intent: 'reasoning', maxChunks: null, minCilScore: null, typeBoosts: { decision: 0.25, confirmed: 0.20 } };
  }

  // Action: "what should I...", "what's next...", "what do I need to...", "open items"
  if (/\b(what\s+should\s+I|what'?s\s+next|what\s+do\s+I\s+need|open\s+(items|loops|tasks)|action\s+items|to-?do)\b/i.test(message)) {
    return { intent: 'action', maxChunks: null, minCilScore: null, typeBoosts: { action_item: 0.25, decision: 0.15 } };
  }

  return null;
}

/**
 * Detect if a chunk contains rule/policy content.
 * Returns { isRule, confidence } where confidence indicates how rule-like the content is.
 */
function isRuleChunk(chunk) {
  const text = ((chunk.content || '') + ' ' + (chunk.heading || '')).toLowerCase();

  // Strong rule indicators
  const strongPatterns = [
    /non-negotiable/,
    /hard rules?/,
    /\bnever\b.*\bwithout\b/,
    /\balways\b.*\brequire/,
    /\bmust\b.*\bapproval/,
    /\bdo not\b.*\bever\b/,
    /\bblocked entirely\b/,
    /\bmandatory\b/,
    /\bcritical.*rule/,
  ];

  // Moderate rule indicators
  const moderatePatterns = [
    /\brules?\b.*:/,
    /\bpolicy\b/,
    /\bguidelines?\b/,
    /\bprotocol\b.*\bnon/,
    /\bguardrails?\b/,
    /\bbefore any\b/,
    /\bno exceptions\b/,
  ];

  const strongMatch = strongPatterns.some(p => p.test(text));
  const moderateMatch = moderatePatterns.filter(p => p.test(text)).length;

  if (strongMatch) return { isRule: true, confidence: 0.9 };
  if (moderateMatch >= 2) return { isRule: true, confidence: 0.7 };
  if (moderateMatch >= 1) return { isRule: true, confidence: 0.4 };
  return { isRule: false, confidence: 0 };
}

/**
 * Apply scoring penalty to rule/policy chunks for factual recall queries.
 * Rules are useful for reasoning queries but should be deprioritized for factual recall.
 * Penalty scales with rule confidence: 0.9 confidence -> 0.64x, 0.4 -> 0.84x
 */
function applyRulePenalty(results, queryIntent, message) {
  // Skip if user is asking about rules/policies
  if (/\brules?\b|\bpolicy\b|\bpolicies\b|\bguidelines?\b/i.test(message)) return;

  // Rules are appropriate for reasoning queries -- no penalty
  if (queryIntent && queryIntent.intent === 'reasoning') return;

  for (const r of results) {
    const ruleInfo = isRuleChunk(r);
    if (!ruleInfo.isRule) continue;

    const penaltyFactor = 1.0 - (ruleInfo.confidence * 0.4);
    r._cilScore = (r._cilScore || 0) * penaltyFactor;
    r._rulePenalty = ruleInfo.confidence;
  }
}

module.exports = { detectQueryIntent, isRuleChunk, applyRulePenalty };
