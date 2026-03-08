/**
 * v7.3 Quality Gate — filter junk before it enters daily memory files.
 */

const SYSTEM_NOISE = /^(HEARTBEAT_OK|NO_REPLY|✅|❌|Done|OK|Got it|session started|auto-indexed)/i;
const URL_ONLY = /^https?:\/\/\S+$/;
const CODE_NOISE_START = /^(```|import |const |function |\/\/)/;
const TIMESTAMP_ONLY = /^\d{4}[-/]\d{2}[-/]\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

// Tags that exempt content from code noise filtering
const CODE_EXEMPT_TAGS = new Set(['decision', 'pref', 'preference']);

function stripBulletsAndTags(text) {
  return text
    .replace(/^\s*[-*]\s*/, '')           // strip leading bullets
    .replace(/\[[\w?]+\]\s*/g, '')        // strip [tag] markers
    .trim();
}

function gateCheck(text, config = {}) {
  if (!config.enabled && config.enabled !== undefined) {
    return { pass: true };
  }

  const minLength = config.minLength || 15;
  const filterSystemNoise = config.filterSystemNoise !== false;
  const filterCodeNoise = config.filterCodeNoise !== false;
  const filterUrlOnly = config.filterUrlOnly !== false;

  if (!text || typeof text !== 'string') {
    return { pass: false, reason: 'empty', details: ['Content is empty or not a string'] };
  }

  const stripped = stripBulletsAndTags(text);

  // Length check
  if (stripped.length < minLength) {
    return { pass: false, reason: 'too_short', details: [`Content "${stripped}" is ${stripped.length} chars (min: ${minLength})`] };
  }

  // System noise
  if (filterSystemNoise && SYSTEM_NOISE.test(stripped)) {
    return { pass: false, reason: 'system_noise', details: [`Matches system noise pattern`] };
  }

  // URL-only
  if (filterUrlOnly && URL_ONLY.test(stripped)) {
    return { pass: false, reason: 'url_only', details: ['Content is only a URL'] };
  }

  // Timestamp-only (under 30 chars)
  if (stripped.length < 30 && TIMESTAMP_ONLY.test(stripped)) {
    return { pass: false, reason: 'timestamp_only', details: ['Content is only a timestamp'] };
  }

  // Code noise — unless tagged as decision/preference
  if (filterCodeNoise) {
    const tag = extractTag(text);
    if (!CODE_EXEMPT_TAGS.has(tag) && CODE_NOISE_START.test(stripped)) {
      return { pass: false, reason: 'code_noise', details: ['Content looks like code, not a memory'] };
    }
  }

  return { pass: true };
}

function extractTag(text) {
  const m = text.match(/\[([\w?]+)\]/);
  return m ? m[1].toLowerCase() : null;
}

module.exports = { gateCheck };
