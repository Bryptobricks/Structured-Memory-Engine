const { getAdjacentChunks } = require('./store');
const { score: computeScore, normalizeFtsScores, RECALL_PROFILE, RECALL_SEMANTIC_PROFILE, resolveProfile, computeTemporalRelevance } = require('./scoring');
const { resolveTemporalQuery } = require('./temporal');
const { detectQueryIntent, applyRulePenalty } = require('./query-features');
const { isStaleRelative, annotateStaleRelative, getRecordedDate } = require('./temporal-freshness');

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
      sourceType: r.source_type || 'indexed',
      domain: r.domain || 'general',
      _andMatch: !!r._andMatch,
    };
  }).sort((a, b) => b.finalScore - a.finalScore); // higher = better
}

function applyTemporalBoost(results, temporal) {
  if (temporal.dateTerms.length === 0) return;
  const isSingleDay = temporal.dateTerms.length === 1 && temporal.until;
  const exactPathBoost = isSingleDay ? 4.0 : 2.5;
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
        r.score *= 1.8;
        r.finalScore *= 1.8;
      }
    } else if (createdDate && temporal.dateTerms.includes(createdDate)) {
      r.score *= 2.0;
      r.finalScore *= 2.0;
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

function applyHeadingBoost(results, query) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  if (queryTerms.length === 0) return;
  for (const r of results) {
    if (!r.heading) continue;
    const headingLower = r.heading.toLowerCase();
    const matches = queryTerms.filter(t => headingLower.includes(t)).length;
    if (matches > 0) {
      const boost = 1.0 + (matches / queryTerms.length) * 0.3;
      r.score *= boost;
      r.finalScore *= boost;
    }
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

function recall(db, query, { limit = 10, since = null, until = null, context = 0, workspace = null, chunkType = null, minConfidence = null, includeStale = false, excludeFromRecall: excludePatterns = null, queryEmbedding = null, recallProfile = null, diversity = null, domain = null } = {}) {
  // Pre-compute temporal + intent (needed for fetchLimit and post-processing)
  const temporal = resolveTemporalQuery(query);
  const intent = detectQueryIntent(query);

  const sinceDate = parseSince(since);
  const untilDate = until || null;
  const fetchLimit = (queryEmbedding || temporal.dateTerms.length > 0 || intent) ? limit * 3 : limit;
  const activeProfile = recallProfile
    ? resolveProfile(recallProfile, !!queryEmbedding)
    : (queryEmbedding ? RECALL_SEMANTIC_PROFILE : RECALL_PROFILE);

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
    domain,
  });

  if (rows.length === 0) return [];

  // v9: Enrich temporal relevance before scoring
  if (temporal.since) {
    for (const r of rows) {
      r._temporalRelevance = computeTemporalRelevance(r, temporal);
    }
  }

  let results = rankResults(rows, activeProfile, { skipNormalize: true });

  // Post-ranking boosts (AND-match already applied via rank boost in retrieve.js)
  applyTemporalBoost(results, temporal);
  applyIntentBoost(results, intent);
  applyHeadingBoost(results, query);
  applyRecallRulePenalty(results, intent, query);
  applySelfReferencePenalty(results, query);

  // Re-sort after boosts and trim to limit
  results.sort((a, b) => b.score - a.score);

  // Optional result diversity (v8) — off by default for recall
  if (diversity) {
    const { enforceResultDiversity } = require('./diversity');
    const divResult = enforceResultDiversity(results, diversity);
    results = divResult.selected;
  }

  results = results.slice(0, limit);

  // Annotate stale-relative chunks so the caller knows dates are relative to recording
  for (const r of results) {
    const recordedDate = getRecordedDate({ file_path: r.filePath, created_at: r.date });
    const check = isStaleRelative(r.content, recordedDate);
    if (check.isStale) {
      r.content = annotateStaleRelative(r.content, recordedDate);
      r.staleRelative = true;
    }
  }

  // Cross-chunk context window
  if (context > 0) {
    for (const r of results) {
      r.context = getAdjacentChunks(db, r.filePath, r.lineStart, r.lineEnd, context);
    }
  }
  return results;
}

module.exports = { recall, parseSince, sanitizeFtsQuery, buildOrQuery, rankResults, loadAliases, STOP_WORDS };
