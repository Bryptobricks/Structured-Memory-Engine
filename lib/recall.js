const { getAdjacentChunks } = require('./store');
const { score: computeScore, normalizeFtsScores, RECALL_PROFILE, RECALL_SEMANTIC_PROFILE } = require('./scoring');
const { resolveTemporalQuery } = require('./temporal');
const { detectQueryIntent, applyRulePenalty } = require('./query-features');

// Shared utilities — defined in retrieve.js, re-exported here for backwards compatibility
const { STOP_WORDS, loadAliases, sanitizeFtsQuery, buildOrQuery, parseSince, retrieveChunks } = require('./retrieve');

function rankResults(rows, profile = RECALL_PROFILE, { skipNormalize = false } = {}) {
  if (rows.length === 0) return [];
  const nowMs = Date.now();
  // Skip normalization when retrieve.js already normalized + enriched the rows
  if (!skipNormalize) normalizeFtsScores(rows);
  return rows.map(r => {
    const finalScore = computeScore(r, nowMs, profile);
    return {
      content: r.content,
      heading: r.heading,
      filePath: r.file_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      ftsScore: r.rank,
      fileWeight: r.file_weight || 1.0,
      confidence: r.confidence != null ? r.confidence : 1.0,
      chunkType: r.chunk_type || 'raw',
      finalScore,
      score: finalScore,
      semanticSim: r._semanticSim || null,
      entities: JSON.parse(r.entities || '[]'),
      date: r.created_at,
      _andMatch: !!r._andMatch,
    };
  }).sort((a, b) => b.finalScore - a.finalScore); // higher = better
}

function applyTemporalBoost(results, temporal) {
  if (temporal.dateTerms.length === 0) return;
  const isSingleDay = temporal.dateTerms.length === 1 && temporal.until;
  const exactPathBoost = isSingleDay ? 2.5 : 1.8;
  for (const r of results) {
    const pathDate = (r.filePath || '').match(/(\d{4}-\d{2}-\d{2})/);
    const createdDate = r.date ? r.date.split('T')[0] : null;
    if (pathDate && temporal.dateTerms.includes(pathDate[1])) {
      r.score *= exactPathBoost;
      r.finalScore *= exactPathBoost;
    } else if (pathDate && temporal.since && temporal.until) {
      const sinceDay = temporal.since.split('T')[0];
      const untilDay = temporal.until.split('T')[0];
      if (pathDate[1] >= sinceDay && pathDate[1] < untilDay) {
        r.score *= 1.3;
        r.finalScore *= 1.3;
      }
    } else if (createdDate && temporal.dateTerms.includes(createdDate)) {
      r.score *= 1.5;
      r.finalScore *= 1.5;
    }
  }
}

function applyIntentBoost(results, intent) {
  if (!intent || !intent.typeBoosts) return;
  for (const r of results) {
    const boost = intent.typeBoosts[r.chunkType];
    if (boost) {
      r.score *= (1 + boost);
      r.finalScore *= (1 + boost);
    }
  }
}

function applyRecallRulePenalty(results, intent, query) {
  // Map score -> _cilScore for applyRulePenalty compatibility
  for (const r of results) r._cilScore = r.score;
  applyRulePenalty(results, intent, query);
  for (const r of results) {
    r.score = r._cilScore;
    r.finalScore = r._cilScore;
  }
}

function applySelfReferencePenalty(results, query) {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (normalizedQuery.length < 15) return;

  for (const r of results) {
    const content = (r.content || '').toLowerCase();
    if (content.includes(normalizedQuery)) {
      const idx = content.indexOf(normalizedQuery);
      const surrounding = content.substring(Math.max(0, idx - 50), idx + normalizedQuery.length + 50);
      if (/\b(test|query|expected|diagnostic|score|spec|benchmark)\b/i.test(surrounding)) {
        r.score *= 0.5;
        r.finalScore *= 0.5;
      }
    }
  }
}

function recall(db, query, { limit = 10, since = null, until = null, context = 0, workspace = null, chunkType = null, minConfidence = null, includeStale = false, excludeFromRecall: excludePatterns = null, queryEmbedding = null } = {}) {
  // Pre-compute temporal + intent (needed for fetchLimit and post-processing)
  const temporal = resolveTemporalQuery(query);
  const intent = detectQueryIntent(query);

  const sinceDate = parseSince(since);
  const untilDate = until || null;
  const fetchLimit = (queryEmbedding || temporal.dateTerms.length > 0 || intent) ? limit * 3 : limit;
  const activeProfile = queryEmbedding ? RECALL_SEMANTIC_PROFILE : RECALL_PROFILE;

  const { rows } = retrieveChunks(db, query, {
    limit: fetchLimit,
    workspace,
    queryEmbedding,
    excludePatterns,
    sinceDate,
    untilDate,
    chunkType,
    minConfidence,
    includeStale,
    rescueMinSim: 0.30,
    rescueMax: 10,
    temporal,
    intent,
  });

  if (rows.length === 0) return [];

  let results = rankResults(rows, activeProfile, { skipNormalize: true });

  // Post-ranking boosts (AND-match already applied via rank boost in retrieve.js)
  applyTemporalBoost(results, temporal);
  applyIntentBoost(results, intent);
  applyRecallRulePenalty(results, intent, query);
  applySelfReferencePenalty(results, query);

  // Re-sort after boosts and trim to limit
  results.sort((a, b) => b.score - a.score);
  results = results.slice(0, limit);

  // Cross-chunk context window
  if (context > 0) {
    for (const r of results) {
      r.context = getAdjacentChunks(db, r.filePath, r.lineStart, r.lineEnd, context);
    }
  }
  return results;
}

module.exports = { recall, parseSince, sanitizeFtsQuery, buildOrQuery, rankResults, loadAliases, STOP_WORDS };
