'use strict';

/**
 * Recall Gate — pure-regex classifier that decides whether a message warrants
 * a full recall pipeline execution. Runs before CIL with zero DB access.
 *
 * Rationale: myapp's Active Memory Plugin fires an 842ms LLM sub-agent on
 * every message including "ok" and "thanks". SME's answer is to skip the
 * pipeline entirely for trivial messages — the cleanest architectural win.
 *
 * Usage:
 *   const { shouldRecall } = require('./recall-gate');
 *   const { shouldRecall: pass, reason } = shouldRecall(message, config);
 *   if (!pass) return { text: '', chunks: [], gated: true, reason };
 */

const ACKNOWLEDGMENTS = /^(ok|okay|sure|thanks|thank\s+you|got\s+it|lol|lmao|haha|yes|no|yep|nope|k|ty|np|cool|nice|great|right|hmm|ah|oh|wow|brb|gg)\s*[.!?]*$/i;
const MATH_EXPR = /^[\d\s+\-*/=().,%]+$/;
const SYSTEM_CMD = /^\/(clear|reset|help|version|status|quit|exit|debug)\b/i;

/**
 * @param {string} message
 * @param {object} [config] — accepts { recallGating: { minMessageLength } }
 * @returns {{ shouldRecall: boolean, reason: string }}
 */
function shouldRecall(message, config = {}) {
  if (typeof message !== 'string') return { shouldRecall: false, reason: 'non-string input' };
  const trimmed = message.trim();
  const minLen = (config.recallGating && config.recallGating.minMessageLength) || 5;

  if (trimmed.length === 0) return { shouldRecall: false, reason: 'empty' };
  // Check specific patterns before length — acks/math/cmds are gated by category, not length
  if (ACKNOWLEDGMENTS.test(trimmed)) return { shouldRecall: false, reason: 'acknowledgment' };
  if (MATH_EXPR.test(trimmed) && /\d/.test(trimmed)) return { shouldRecall: false, reason: 'math expression' };
  if (SYSTEM_CMD.test(trimmed)) return { shouldRecall: false, reason: 'system command' };
  if (trimmed.length < minLen) return { shouldRecall: false, reason: 'too short' };

  return { shouldRecall: true, reason: 'passes gate' };
}

module.exports = { shouldRecall, ACKNOWLEDGMENTS, MATH_EXPR, SYSTEM_CMD };
