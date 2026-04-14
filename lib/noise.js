'use strict';

const OPS_NOISE_RE = /\b(session_id|message_id|chat_id|thread_id|update_id|request_id|response_id|call_id|user_id|assistant_id|conversation_id|prompt_tokens|completion_tokens|total_tokens|mime_type|content_type|file_size|sha256|md5|timestamp|created_at|updated_at)\b/gi;
const KV_LINE_RE = /^\s*["'`]?([a-z_][a-z0-9_.-]{1,63})["'`]?\s*[:=]\s*.+$/;
const CONVERSATION_META_RE = /conversation info\s*\(untrusted metadata\)/i;
const JSONISH_META_RE = /^\s*[{"].*[:=].*[}\]]?\s*$/;

function getMetadataStats(text) {
  if (!text || typeof text !== 'string') {
    return { nonEmptyLines: 0, kvLines: 0, density: 0, keywordHits: 0 };
  }

  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const kvLines = lines.filter(line => KV_LINE_RE.test(line) || JSONISH_META_RE.test(line)).length;
  const keywordHits = (text.match(OPS_NOISE_RE) || []).length;
  const nonEmptyLines = lines.length;
  const density = nonEmptyLines > 0 ? kvLines / nonEmptyLines : 0;
  OPS_NOISE_RE.lastIndex = 0;

  return { nonEmptyLines, kvLines, density, keywordHits };
}

function metadataDensityPenalty(text) {
  const stats = getMetadataStats(text);

  if (CONVERSATION_META_RE.test(text)) return 0.05;
  if (stats.nonEmptyLines >= 3 && stats.density > 0.5) return 0.15;
  if (stats.nonEmptyLines >= 3 && stats.density > 0.3) return 0.5;
  if (stats.keywordHits >= 5 && stats.nonEmptyLines >= 3) return 0.5;
  return 1.0;
}

function isMetadataHeavy(text) {
  return metadataDensityPenalty(text) <= 0.15;
}

module.exports = {
  OPS_NOISE_RE,
  KV_LINE_RE,
  getMetadataStats,
  metadataDensityPenalty,
  isMetadataHeavy,
};
