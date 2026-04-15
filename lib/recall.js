const crypto = require('crypto');
const { getAdjacentChunks } = require('./store');
const { score: computeScore, normalizeFtsScores, RECALL_PROFILE, RECALL_SEMANTIC_PROFILE, resolveProfile } = require('./scoring');
const { resolveTemporalQuery } = require('./temporal');
const { detectQueryIntent, applyRulePenalty } = require('./query-features');
const { extractQueryEntities, getEntityIndexMap } = require('./entities');
const { classifyStrategy } = require('./orchestrator');
const { checkPromotion } = require('./memory-tier');

// Shared utilities — defined in retrieve.js, re-exported here for backwards compatibility
const { STOP_WORDS, loadAliases, sanitizeFtsQuery, buildOrQuery, parseSince, retrieveChunks } = require('./retrieve');

function rankResults(rows, profile = RECALL_PROFILE, { skipNormalize = false, queryEntities = null, entityIndexMap = null } = {}) {
  if (rows.length === 0) return [];
  const nowMs = Date.now();
  // Skip normalization when retrieve.js already normalized + enriched the rows
  if (!skipNormalize) normalizeFtsScores(rows);
  const overrides = (queryEntities && queryEntities.length > 0 && entityIndexMap)
    ? { queryEntities, entityIndexMap }
    : undefined;
  return rows.map(r => {
    const finalScore = computeScore(r, nowMs, profile, overrides);
    return {
      id: r.id,
      content: r.content,
      heading: r.heading,
      filePath: r.file_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      ftsScore: r.rank,
      fileWeight: r.file_weight || 1.0,
      confidence: r.confidence != null ? r.confidence : 1.0,
      chunkType: r.chunk_type || 'raw',
      memoryTier: r.memory_tier || 'working_reference',
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

function recall(db, query, { limit = 10, since = null, until = null, context = 0, workspace = null, chunkType = null, minConfidence = null, includeStale = false, excludeFromRecall: excludePatterns = null, queryEmbedding = null, recallProfile = null, filterMetadataNoise = true, orchestrator: orchestratorOpt = true, explain = false, recordStats = true } = {}) {
  // Pre-compute temporal + intent (needed for fetchLimit and post-processing)
  const temporal = resolveTemporalQuery(query);
  const intent = detectQueryIntent(query);

  // Entity mention scoring (F5) — extract query entities once, before strategy classification.
  // Orchestrator (F1) uses detected entities to decide whether requireEntities strategies fire.
  let queryEntities = null;
  let entityIndexMap = null;
  try {
    queryEntities = extractQueryEntities(db, query);
    if (queryEntities.length > 0) {
      entityIndexMap = getEntityIndexMap(db, queryEntities);
    }
  } catch (_) { /* entity index may not exist yet — non-fatal */ }

  // Strategy classification (F1 Orchestrator) — skipped when caller explicitly passed recallProfile.
  let strategy = null;
  if (!recallProfile && orchestratorOpt !== false) {
    strategy = classifyStrategy(query, queryEntities || []);
  }

  const sinceDate = parseSince(since);
  const untilDate = until || null;
  const fetchLimit = (queryEmbedding || temporal.dateTerms.length > 0 || intent) ? limit * 3 : limit;
  const activeProfile = recallProfile
    ? resolveProfile(recallProfile, !!queryEmbedding)
    : (strategy && strategy.profile)
      ? resolveProfile(strategy.profile, !!queryEmbedding)
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
    filterMetadataNoise,
    rescueMinSim: 0.30,
    rescueMax: 10,
    temporal,
    intent,
  });

  if (rows.length === 0) {
    if (explain) {
      return { results: [], explain: buildExplain(strategy, activeProfile, queryEntities, query) };
    }
    return [];
  }

  let results = rankResults(rows, activeProfile, { skipNormalize: true, queryEntities, entityIndexMap });

  // Post-ranking boosts (AND-match already applied via rank boost in retrieve.js)
  applyTemporalBoost(results, temporal);
  applyIntentBoost(results, intent);
  applyHeadingBoost(results, query);
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

  // F2: Record recall stats + apply inline tier promotion.
  // Skipped when caller passes recordStats: false (e.g. benchmark runs, internal
  // recursive calls) so we don't inflate counters from non-user activity.
  if (recordStats !== false) {
    try { recordRecallStats(db, results, query); }
    catch (err) { /* non-fatal: tiering columns may not exist yet */ }
  }

  if (explain) {
    return { results, explain: buildExplain(strategy, activeProfile, queryEntities, query) };
  }
  return results;
}

/**
 * Record recall statistics for returned chunks and apply inline tier promotions.
 * Runs after results are trimmed to the caller's limit — only the chunks the
 * user actually sees count toward recall_count / unique_query_count.
 *
 * Called ONLY from the top-level recall() path (sme_query). CIL recall
 * doesn't inflate stats because every turn would otherwise increment counts.
 *
 * @param {Database} db
 * @param {Array} results — mapped result objects (must have .id)
 * @param {string} query — the original query string
 */
function recordRecallStats(db, results, query) {
  if (!results || results.length === 0) return;
  const ids = results.map(r => r.id).filter(id => id != null);
  if (ids.length === 0) return;

  const queryHash = crypto.createHash('sha1').update(query.toLowerCase().trim()).digest('hex').slice(0, 12);
  const selectChunk = db.prepare('SELECT id, recall_count, unique_query_count, query_hash_seen, memory_tier FROM chunks WHERE id = ?');
  const updateStats = db.prepare('UPDATE chunks SET recall_count = ?, unique_query_count = ?, query_hash_seen = ?, memory_tier = ? WHERE id = ?');

  const tx = db.transaction(() => {
    for (const id of ids) {
      const chunk = selectChunk.get(id);
      if (!chunk) continue;

      let seen;
      try { seen = JSON.parse(chunk.query_hash_seen || '[]'); if (!Array.isArray(seen)) seen = []; }
      catch (_) { seen = []; }

      const isNewQuery = !seen.includes(queryHash);
      if (isNewQuery) seen.push(queryHash);
      // Bound the array — keep the last 50 distinct query hashes
      if (seen.length > 50) seen.splice(0, seen.length - 50);

      const nextRecall = (chunk.recall_count || 0) + 1;
      const nextUnique = isNewQuery ? (chunk.unique_query_count || 0) + 1 : (chunk.unique_query_count || 0);

      // Check for promotion with the new stats
      const candidateChunk = {
        memory_tier: chunk.memory_tier,
        recall_count: nextRecall,
        unique_query_count: nextUnique,
      };
      const newTier = checkPromotion(candidateChunk) || chunk.memory_tier;

      updateStats.run(nextRecall, nextUnique, JSON.stringify(seen), newTier, id);
    }
  });
  tx();
}

/**
 * Build an --explain report describing how a query was classified and scored.
 * Used by `sme query "..." --explain` for debugging orchestrator decisions.
 */
function buildExplain(strategy, profile, queryEntities, query) {
  const s = strategy || { strategy: 'quick_context', reason: 'caller-specified profile', profile: null };
  const weights = Object.entries(profile)
    .filter(([k, v]) => typeof v === 'number' && k !== 'confidenceExponent' && k !== 'recencyHalfLifeDays')
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(' ');
  return {
    query,
    strategy: s.strategy,
    reason: s.reason,
    profile: s.profile || 'default',
    weights,
    halfLife: profile.recencyHalfLifeDays,
    confExponent: profile.confidenceExponent,
    queryEntities: queryEntities || [],
  };
}

module.exports = { recall, parseSince, sanitizeFtsQuery, buildOrQuery, rankResults, loadAliases, STOP_WORDS, buildExplain };
