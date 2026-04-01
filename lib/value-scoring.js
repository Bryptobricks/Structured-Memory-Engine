'use strict';

/**
 * v7.4 Multi-Feature Value Scoring — compute quality scores for memory chunks.
 * Calibration-first: scores are stored but NOT used for live recall ranking yet.
 */

const { TYPE_BONUS } = require('./scoring');
const { extractTerms } = require('./reflect');
const { isRuleChunk } = require('./query-features');

// --- Feature detectors ---

const PERSONAL_PATTERNS = [
  /\b(prefers?|likes?|loves?|hates?|dislikes?|favorite)\b/i,
  /\b(lives?|works?\s+at|weighs|takes\s+\d+mg|blood\s?type)\b/i,
  /\b(girlfriend|boyfriend|partner|wife|husband|friend|parri)\b/i,
  /\b(dose|dosage|mg|prescription|supplement|medication|blood|lab|creatinine)\b/i,
  /\b(portfolio|net\s+worth|bought|sold|salary|income|switched\s+(from|to))\b/i,
  /\b(allergic|intolerant|diagnosed)\b/i,
];

const OPS_NOISE_PATTERNS = [
  /\b(run:|script|cron|pipeline|phase\s+\d+)\b/i,
  /\b(auto-indexed|session started|compaction|heartbeat)\b/i,
  /\b(API_KEY|endpoint|webhook|token|port\b|config(?:uration)?)\b/i,
  /(?:\/Users\/|\.js\b|\.ts\b|node_modules)/i,
];

const VAGUE_WORDS = /\b(something|anything|stuff|things|general update|misc|various)\b/i;

const DURABLE_PATTERNS = [
  /\b(identity|blood\s?type|allergic|born|maiden\s+name)\b/i,
  /\b(girlfriend|boyfriend|partner|wife|husband|married)\b/i,
  /\b(baseline|benchmark|reference\s+range)\b/i,
  /\b(net\s+worth|retirement|trust|estate)\b/i,
];

/**
 * Compute feature scores for a chunk.
 */
function computeFeatures(chunk) {
  const content = chunk.content || '';
  const chunkType = chunk.chunk_type || 'raw';
  const confidence = chunk.confidence != null ? chunk.confidence : 1.0;

  // personal_relevance: 1.0 if any personal pattern matches, else 0.0
  const personal_relevance = PERSONAL_PATTERNS.some(p => p.test(content)) ? 1.0 : 0.0;

  // operational_noise: 0.25 per pattern hit, capped at 1.0
  let noiseHits = 0;
  for (const p of OPS_NOISE_PATTERNS) {
    if (p.test(content)) noiseHits++;
  }
  const operational_noise = Math.min(1.0, noiseHits * 0.25);

  // specificity: based on distinct token count + number bonus - vague penalty
  const tokens = extractTerms(content);
  const distinctTokens = new Set(tokens).size;
  let specificity = Math.min(distinctTokens, 20) / 20;
  if (/\d+/.test(content)) specificity = Math.min(1.0, specificity + 0.15);
  if (VAGUE_WORDS.test(content)) specificity = Math.max(0, specificity - 0.2);

  // durability: based on chunk_type + durable pattern bonus
  const DURABILITY_BY_TYPE = {
    confirmed: 1.0,
    decision: 1.0,
    preference: 1.0,
    fact: 0.7,
    opinion: 0.3,
    action_item: 0.3,
    raw: 0.1,
    inferred: 0.1,
    outdated: 0.0,
  };
  let durability = DURABILITY_BY_TYPE[chunkType] != null ? DURABILITY_BY_TYPE[chunkType] : 0.1;
  if (DURABLE_PATTERNS.some(p => p.test(content))) {
    durability = Math.min(1.0, durability + 0.2);
  }

  // retrieval_utility: composite of type bonus + confidence
  const typeBonus = TYPE_BONUS[chunkType] || 0;
  const normalizedTypeBonus = (typeBonus + 0.20) / 0.45; // normalize to ~0-1 range
  const retrieval_utility = Math.min(1.0, normalizedTypeBonus * 0.65 + confidence * 0.35);

  return {
    personal_relevance,
    operational_noise,
    specificity,
    durability,
    retrieval_utility,
  };
}

/**
 * Compute weighted value score from features.
 */
function computeValueScore(features) {
  const raw = features.personal_relevance * 0.25
    + features.retrieval_utility * 0.25
    + features.specificity * 0.15
    + features.durability * 0.20
    - features.operational_noise * 0.25;
  return Math.max(0.0, Math.min(1.0, raw));
}

/**
 * Classify value score into a label.
 */
function classifyValue(score) {
  if (score >= 0.70) return 'core';
  if (score >= 0.35) return 'situational';
  if (score >= 0.15) return 'noise';
  return 'junk';
}

/**
 * Compute full value assessment for a chunk.
 */
function assessChunkValue(chunk) {
  const features = computeFeatures(chunk);
  const valueScore = computeValueScore(features);
  const valueLabel = classifyValue(valueScore);
  return { features, valueScore, valueLabel };
}

/**
 * Classify chunk priority: 'high', 'medium', or 'low'.
 * Rule-based, no LLM calls.
 */
function classifyPriority(chunk) {
  const content = chunk.content || '';
  const chunkType = chunk.chunk_type || 'raw';
  const confidence = chunk.confidence != null ? chunk.confidence : 1.0;

  // High priority checks
  if (chunkType === 'confirmed' || chunkType === 'decision') return 'high';
  if (PERSONAL_PATTERNS.some(p => p.test(content))) return 'high';
  if (DURABLE_PATTERNS.some(p => p.test(content))) return 'high';
  if (/\$\s*[\d,]+(?:\.\d+)?/.test(content)) {
    const match = content.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (match) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (amount > 1000) return 'high';
    }
  }
  if (/\b(medication|prescription|dose|dosage|diagnosis|allergic|surgery)\b/i.test(content)) return 'high';
  const ruleCheck = isRuleChunk({ content, heading: chunk.heading || '' });
  if (ruleCheck && ruleCheck.isRule) return 'high';

  // Low priority checks
  if (chunkType === 'raw' || chunkType === 'inferred') return 'low';
  const features = computeFeatures(chunk);
  if (features.operational_noise > 0.5) return 'low';
  if (VAGUE_WORDS.test(content)) return 'low';
  if (content.length < 20) return 'low';
  if (chunk.created_at) {
    const ageMs = Date.now() - new Date(chunk.created_at).getTime();
    if (ageMs > 90 * 86400000 && confidence < 0.5) return 'low';
  }

  return 'medium';
}

module.exports = {
  computeFeatures,
  computeValueScore,
  classifyValue,
  assessChunkValue,
  classifyPriority,
  PERSONAL_PATTERNS,
  OPS_NOISE_PATTERNS,
  DURABLE_PATTERNS,
  VAGUE_WORDS,
};
