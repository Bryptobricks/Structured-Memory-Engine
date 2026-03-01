'use strict';

const { search, getChunksByFile } = require('./store');
const { extractTerms } = require('./reflect');
const { sanitizeFtsQuery, buildOrQuery, loadAliases, STOP_WORDS } = require('./recall');
const { expandEntitiesWithCooccurrence } = require('./entities');
const { cosineSimilarity } = require('./embeddings');
const { score: computeScore, normalizeFtsScores, CIL_PROFILE, CIL_SEMANTIC_PROFILE } = require('./scoring');
const { isExcludedFromRecall, resolveFileWeight } = require('./config');
const { logRecall } = require('./recall-logger');
const { resolveTemporalQuery, isAttributionQuery } = require('./temporal');

// Entity cache — rebuilt at most once per ENTITY_CACHE_TTL
let _entityCache = null;
let _entityCacheTime = 0;
const ENTITY_CACHE_TTL = 60000; // 1 minute

function extractQueryTerms(message) {
  const terms = extractTerms(message)
    .filter(t => !STOP_WORDS.has(t.toLowerCase()));

  // Preserve capitalized terms that look like proper nouns (e.g., "Alex", "Echelon")
  const properNouns = message.match(/\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*\b/g) || [];
  for (const pn of properNouns) {
    const lower = pn.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower) && !terms.includes(lower)) {
      terms.push(lower);
    }
  }

  return terms;
}

/**
 * Detect query intent for parameter adjustments.
 * Returns { intent, maxChunks, minCilScore, typeBoosts } or null.
 */
function detectQueryIntent(message) {
  const m = message.toLowerCase();

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

function cilScore(chunk, nowMs, opts) {
  const profile = opts.profile || CIL_PROFILE;
  const overrides = opts.recencyBoostDays ? { recencyHalfLifeDays: opts.recencyBoostDays } : undefined;
  return computeScore(chunk, nowMs, profile, overrides);
}

function budgetChunks(rankedChunks, maxTokens) {
  // Per-chunk metadata line (source, type, conf, age) ≈ 25 tokens each
  const HEADER_OVERHEAD = 30;
  const PER_CHUNK_OVERHEAD = 25;
  let budget = maxTokens - HEADER_OVERHEAD;
  const selected = [];

  for (const chunk of rankedChunks) {
    const chunkTokens = Math.ceil(chunk.content.length / 3.5) + PER_CHUNK_OVERHEAD;
    if (chunkTokens > budget) {
      if (budget > 100) {
        const availableForContent = budget - PER_CHUNK_OVERHEAD;
        if (availableForContent > 50) {
          const truncatedChars = Math.floor(availableForContent * 3.5);
          let truncated = chunk.content.slice(0, truncatedChars);
          const lastSentence = truncated.lastIndexOf('. ');
          const lastNewline = truncated.lastIndexOf('\n');
          const cutPoint = Math.max(lastSentence + 1, lastNewline);
          if (cutPoint > truncatedChars * 0.5) {
            truncated = truncated.slice(0, cutPoint);
          }
          truncated += '…';
          selected.push({ ...chunk, content: truncated, truncated: true });
        }
      }
      break;
    }
    budget -= chunkTokens;
    selected.push(chunk);
  }

  return selected;
}

function daysSinceLabel(dateStr) {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return ' (today)';
  if (days === 1) return ' (yesterday)';
  if (days < 7) return ` (${days}d ago)`;
  if (days < 30) return ` (${Math.floor(days / 7)}w ago)`;
  return ` (${Math.floor(days / 30)}mo ago)`;
}

function findContradictionsInResults(db, selectedChunks) {
  if (selectedChunks.length < 2) return [];
  const ids = selectedChunks.map(c => c.id).filter(Boolean);
  if (ids.length < 2) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT c.*, ca.content as content_old, cb.content as content_new
    FROM contradictions c
    JOIN chunks ca ON ca.id = c.chunk_id_old
    JOIN chunks cb ON cb.id = c.chunk_id_new
    WHERE c.chunk_id_old IN (${placeholders}) OR c.chunk_id_new IN (${placeholders})
  `).all(...ids, ...ids);

  return rows.map(r => ({
    chunkA: { content: r.content_old },
    chunkB: { content: r.content_new },
    reason: r.reason,
  }));
}

function formatContext(selectedChunks, contradictions) {
  if (selectedChunks.length === 0) return '';

  let out = '## Recalled Context\nStructured memories retrieved by relevance. Source citations included.\n\n';

  for (const chunk of selectedChunks) {
    const age = chunk.date ? daysSinceLabel(chunk.date) : '';
    const confLabel = chunk.confidence >= 0.9 ? '' :
                      chunk.confidence >= 0.6 ? ' ⚠low-conf' :
                      ' ⚠⚠very-low-conf';
    const typeLabel = chunk.chunkType !== 'raw' ? ` [${chunk.chunkType}]` : '';
    const source = `${chunk.filePath}:${chunk.lineStart}`;

    out += `- ${chunk.content}`;
    if (chunk.truncated) out += ' [truncated]';
    out += `\n  ↳ ${source}${typeLabel}${confLabel}${age}\n`;
  }

  if (contradictions.length > 0) {
    out += '\n⚠ Potential contradictions detected:\n';
    for (const c of contradictions) {
      out += `- "${c.chunkA.content.slice(0, 80)}…" vs "${c.chunkB.content.slice(0, 80)}…" (${c.reason})\n`;
    }
  }

  return out;
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
 * Penalty scales with rule confidence: 0.9 confidence → 0.64x, 0.4 → 0.84x
 */
function applyRulePenalty(results, queryIntent, message) {
  // Skip if user is asking about rules/policies
  if (/\brules?\b|\bpolicy\b|\bpolicies\b|\bguidelines?\b/i.test(message)) return;

  // Rules are appropriate for reasoning queries — no penalty
  if (queryIntent && queryIntent.intent === 'reasoning') return;

  for (const r of results) {
    const ruleInfo = isRuleChunk(r);
    if (!ruleInfo.isRule) continue;

    const penaltyFactor = 1.0 - (ruleInfo.confidence * 0.4);
    r._cilScore = (r._cilScore || 0) * penaltyFactor;
    r._rulePenalty = ruleInfo.confidence;
  }
}

/**
 * Inject priority files for action intent queries.
 * Bypasses FTS entirely — queries the DB directly for chunks from configured
 * priority files and ensures they appear with a minimum score floor.
 */
function injectPriorityFiles(db, intent, results, effectiveExclusions, confidenceFloor) {
  if (!intent || intent.intent !== 'action') return results;

  const priorityPaths = ['memory/open-loops.md'];
  const PRIORITY_SCORE_FLOOR = 0.55;
  const SELF_REVIEW_SCORE_FLOOR = 0.50;

  const existingIds = new Set(results.map(r => r.id));

  for (const pathPattern of priorityPaths) {
    const matching = getChunksByFile(db, pathPattern);
    // Filter exclusions and confidence
    const filtered = matching.filter(c => {
      if (effectiveExclusions && effectiveExclusions.length > 0 && isExcludedFromRecall(c.file_path, effectiveExclusions)) return false;
      if ((c.confidence != null ? c.confidence : 1.0) < confidenceFloor) return false;
      return true;
    });

    for (const chunk of filtered.slice(0, 3)) {
      if (existingIds.has(chunk.id)) {
        // Already in results — ensure minimum score
        const existing = results.find(r => r.id === chunk.id);
        if (existing) {
          existing._cilScore = Math.max(existing._cilScore || 0, PRIORITY_SCORE_FLOOR);
          existing._injected = true;
        }
      } else {
        // Not in FTS results — inject with score floor
        chunk._cilScore = PRIORITY_SCORE_FLOOR;
        chunk._injected = true;
        chunk._normalizedFts = 0;
        chunk._entityMatch = false;
        results.push(chunk);
        existingIds.add(chunk.id);
      }
    }
  }

  // Inject latest self-review (top 2 chunks by created_at)
  const selfReviewChunks = getChunksByFile(db, 'self-review');
  selfReviewChunks.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const filteredSr = selfReviewChunks.filter(c => {
    if (effectiveExclusions && effectiveExclusions.length > 0 && isExcludedFromRecall(c.file_path, effectiveExclusions)) return false;
    if ((c.confidence != null ? c.confidence : 1.0) < confidenceFloor) return false;
    return true;
  });

  for (const chunk of filteredSr.slice(0, 2)) {
    if (existingIds.has(chunk.id)) {
      const existing = results.find(r => r.id === chunk.id);
      if (existing) {
        existing._cilScore = Math.max(existing._cilScore || 0, SELF_REVIEW_SCORE_FLOOR);
        existing._injected = true;
      }
    } else {
      chunk._cilScore = SELF_REVIEW_SCORE_FLOOR;
      chunk._injected = true;
      chunk._normalizedFts = 0;
      chunk._entityMatch = false;
      results.push(chunk);
      existingIds.add(chunk.id);
    }
  }

  return results;
}

/**
 * getRelevantContext — CIL core retrieval pipeline.
 *
 * @param {Database} db - better-sqlite3 handle from store.openDb()
 * @param {string} message - the user's current message (raw text)
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=1500] - token budget for injected context
 * @param {number} [opts.maxChunks=10] - hard cap on chunks before token budgeting
 * @param {number} [opts.confidenceFloor=0.2] - drop chunks below this confidence
 * @param {number} [opts.recencyBoostDays=30] - full recency boost within this window
 * @param {string} [opts.workspace=null] - workspace path (for alias loading)
 * @param {boolean} [opts.flagContradictions=true] - inline contradiction markers
 * @param {string[]} [opts.conversationContext=[]] - recent user messages for multi-turn awareness
 * @param {Float32Array} [opts.queryEmbedding=null] - pre-computed query embedding for semantic scoring
 * @param {string[]} [opts.excludeFromRecall=[]] - file path patterns to exclude from results
 * @returns {{ text: string, chunks: Array<CILChunk>, tokenEstimate: number }}
 */
function getRelevantContext(db, message, opts = {}) {
  const startMs = Date.now();
  const {
    maxTokens = 1500,
    maxChunks: maxChunksOpt = 10,
    confidenceFloor = 0.4,
    recencyBoostDays = 30,
    workspace = null,
    flagContradictions = true,
    conversationContext = [],
    queryEmbedding = null,
    excludeFromRecall: excludePatterns = null,
    minCilScore: minCilScoreOpt = 0.15,
    fileWeights = null,
  } = opts;

  if (!message || !message.trim()) {
    return { text: '', chunks: [], tokenEstimate: 0 };
  }

  // Query intent detection — adjust pipeline parameters
  const intent = detectQueryIntent(message);
  let maxChunks = (intent && intent.maxChunks) || maxChunksOpt;
  let minCilScore = (intent && intent.minCilScore != null) ? intent.minCilScore : minCilScoreOpt;

  // Temporal preprocessing — resolve "yesterday", "last week", etc.
  const temporal = resolveTemporalQuery(message);
  const queryForTerms = temporal.strippedQuery || message;

  // Temporal date queries need looser thresholds — chunks from specific dates often
  // have weak FTS scores but are highly relevant due to date match
  if (temporal.dateTerms.length > 0) {
    minCilScore = Math.min(minCilScore, 0.05);
    maxChunks = Math.max(maxChunks, 8);
  }

  const terms = extractQueryTerms(queryForTerms);

  // Inject date terms from temporal resolution (e.g., "2026-02-27" for "yesterday")
  for (const dt of temporal.dateTerms) {
    if (!terms.includes(dt)) terms.push(dt);
  }

  // Multi-turn: extract terms from recent conversation for broader recall
  const contextTerms = new Set(terms);
  if (Array.isArray(conversationContext)) {
    for (const msg of conversationContext.slice(-3)) {
      if (msg && typeof msg === 'string') {
        for (const t of extractQueryTerms(msg)) {
          contextTerms.add(t);
        }
      }
    }
  }

  // Action intent: inject action-related terms so FTS can find open-loops, tasks, priorities
  if (intent && intent.intent === 'action') {
    for (const t of ['priority', 'pending', 'action', 'focus', 'task', 'loop', 'waiting', 'blocked']) {
      contextTerms.add(t);
    }
  }

  if (contextTerms.size === 0) {
    return { text: '', chunks: [], tokenEstimate: 0 };
  }

  // Build known entity set for entity-match bonus (cached with TTL)
  const now = Date.now();
  let knownEntities;
  if (_entityCache && (now - _entityCacheTime) < ENTITY_CACHE_TTL) {
    knownEntities = _entityCache;
  } else {
    knownEntities = new Set();
    const entityRows = db.prepare('SELECT DISTINCT entities FROM chunks WHERE entities IS NOT NULL AND entities != \'[]\'').all();
    for (const row of entityRows) {
      try {
        for (const e of JSON.parse(row.entities)) {
          knownEntities.add(e.toLowerCase().replace(/^@/, ''));
        }
      } catch (_) {}
    }
    _entityCache = knownEntities;
    _entityCacheTime = now;
  }

  // Check which entities appear in the message + conversation context
  const allText = [message, ...(conversationContext || [])].join(' ').toLowerCase();
  const matchedEntities = new Set();
  for (const entity of knownEntities) {
    if (entity.length >= 2 && allText.includes(entity)) {
      matchedEntities.add(entity);
    }
  }

  // Expand matched entities with co-occurring entities from the entity graph
  try {
    const expanded = expandEntitiesWithCooccurrence(db, matchedEntities);
    for (const e of expanded) matchedEntities.add(e);
  } catch (_) {
    // Entity index may not exist yet — that's fine, skip expansion
  }

  // Attribution query detection — lift transcript exclusions for "what did X say" queries
  const attribution = isAttributionQuery(message, knownEntities);
  const alwaysExclude = opts.alwaysExclude || [];
  const effectiveExclusions = attribution.isAttribution
    ? alwaysExclude  // Only keep the always-exclude list, lift auto-recall exclusions
    : excludePatterns;

  // Temporal recency boost override
  const effectiveRecencyBoost = temporal.recencyBoost || recencyBoostDays;

  // Dual query: AND (precision) then OR with aliases (recall)
  const fetchLimit = maxChunks * 5;
  const searchOpts = {
    limit: fetchLimit,
    minConfidence: confidenceFloor,
    skipTracking: true,
    sinceDate: temporal.since || null,
    untilDate: temporal.until || null,
  };
  const seen = new Map(); // id → result

  // AND query — use stripped query (temporal phrases removed)
  const andQuery = sanitizeFtsQuery(queryForTerms);
  if (andQuery) {
    try {
      const andRows = search(db, andQuery, searchOpts);
      for (const r of andRows) {
        r._andMatch = true;
        seen.set(r.id, r);
      }
    } catch (_) {}
  }

  // Date term query — inject resolved dates as OR terms for file path matching
  if (temporal.dateTerms.length > 0) {
    const dateQuery = temporal.dateTerms.map(dt => '"' + dt + '"').join(' OR ');
    try {
      const dateRows = search(db, dateQuery, searchOpts);
      for (const r of dateRows) {
        if (!seen.has(r.id)) {
          seen.set(r.id, r);
        }
      }
    } catch (_) {}
  }

  // OR query with alias expansion (includes conversation context terms)
  let aliases = {};
  try { aliases = loadAliases(workspace); } catch (_) {}
  const orInput = contextTerms.size > terms.length
    ? [...contextTerms].join(' ')
    : queryForTerms;
  const orQuery = buildOrQuery(orInput, aliases);
  if (orQuery) {
    try {
      const orRows = search(db, orQuery, searchOpts);
      for (const r of orRows) {
        if (!seen.has(r.id)) {
          seen.set(r.id, r);
        }
      }
    } catch (_) {}
  }

  // Forward-looking rescue — when query is about future events,
  // also search recent chunks (last 14d) without date filters
  // for action_items, decisions, and plan-related content
  if (temporal.forwardLooking && temporal.since) {
    const recentSince = new Date();
    recentSince.setDate(recentSince.getDate() - 14);
    const fwdSearchOpts = { ...searchOpts, sinceDate: recentSince.toISOString(), untilDate: null };
    if (orQuery) {
      try {
        const fwdRows = search(db, orQuery, fwdSearchOpts);
        for (const r of fwdRows) {
          if (!seen.has(r.id)) seen.set(r.id, r);
        }
      } catch (_) {}
    }
    // Also search for forward terms (e.g., month names like "march") without date filters
    // — content about March written in February won't have March dates
    if (temporal.forwardTerms && temporal.forwardTerms.length > 0) {
      const fwdTermQuery = temporal.forwardTerms.map(t => '"' + t + '"').join(' OR ');
      try {
        const fwdTermRows = search(db, fwdTermQuery, fwdSearchOpts);
        for (const r of fwdTermRows) {
          if (!seen.has(r.id)) seen.set(r.id, r);
        }
      } catch (_) {}
    }
  }

  let results = [...seen.values()];
  let totalFetched = results.length;

  // Filter out excluded files before scoring
  let excludedByPattern = 0;
  if (effectiveExclusions && effectiveExclusions.length > 0) {
    const before = results.length;
    results = results.filter(r => !isExcludedFromRecall(r.file_path, effectiveExclusions));
    excludedByPattern = before - results.length;
  }

  // Early return only when no FTS results AND no embedding for rescue
  if (results.length === 0 && !queryEmbedding) {
    if (workspace) {
      try {
        logRecall(workspace, {
          query: message, queryTerms: [...contextTerms],
          chunksReturned: 0, chunksDropped: totalFetched, excludedByPattern,
          tokenEstimate: 0, chunks: [], durationMs: Date.now() - startMs,
        });
      } catch (_) {}
    }
    return { text: '', chunks: [], tokenEstimate: 0 };
  }

  // AND-match bonus: boost FTS rank for precision matches
  for (const r of results) {
    if (r._andMatch) {
      r.rank = r.rank * 1.3; // more negative = better, so multiply amplifies
    }
  }

  // Normalize FTS scores across all results
  normalizeFtsScores(results);

  // Determine scoring profile once for this query (not per-chunk)
  const activeProfile = queryEmbedding ? CIL_SEMANTIC_PROFILE : CIL_PROFILE;

  // Semantic similarity + embedding rescue
  if (queryEmbedding && queryEmbedding.length > 0) {
    // Set _semanticSim on FTS candidates
    const ftsIds = results.map(r => r.id);
    if (ftsIds.length > 0) {
      const placeholders = ftsIds.map(() => '?').join(',');
      let embRows = [];
      try {
        embRows = db.prepare(`SELECT id, embedding FROM chunks WHERE id IN (${placeholders}) AND embedding IS NOT NULL`).all(...ftsIds);
      } catch (_) {}
      const embMap = new Map();
      for (const row of embRows) {
        const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        embMap.set(row.id, vec);
      }
      for (const r of results) {
        const stored = embMap.get(r.id);
        r._semanticSim = stored ? cosineSimilarity(queryEmbedding, stored) : 0;
      }
    }

    // Embedding rescue — find chunks with good semantic match that FTS missed
    const RESCUE_MIN_SIM = 0.25;
    const existingIds = new Set(ftsIds);
    let allEmbRows = [];
    try {
      allEmbRows = db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL').all();
    } catch (_) {}

    const rescueCandidates = [];
    for (const row of allEmbRows) {
      if (existingIds.has(row.id)) continue;
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const sim = cosineSimilarity(queryEmbedding, vec);
      if (sim >= RESCUE_MIN_SIM) {
        rescueCandidates.push({ id: row.id, sim });
      }
    }

    if (rescueCandidates.length > 0) {
      rescueCandidates.sort((a, b) => b.sim - a.sim);
      const topRescue = rescueCandidates.slice(0, maxChunks);
      const rescueIds = topRescue.map(r => r.id);
      const rph = rescueIds.map(() => '?').join(',');
      let rescueChunks = [];
      try {
        rescueChunks = db.prepare(`SELECT * FROM chunks WHERE id IN (${rph})`).all(...rescueIds);
      } catch (_) {}
      const simMap = new Map(topRescue.map(r => [r.id, r.sim]));
      let rescuedCount = 0;
      for (const rc of rescueChunks) {
        if (effectiveExclusions && effectiveExclusions.length > 0 && isExcludedFromRecall(rc.file_path, effectiveExclusions)) continue;
        if ((rc.confidence != null ? rc.confidence : 1.0) < confidenceFloor) continue;
        if (searchOpts.sinceDate && rc.created_at < searchOpts.sinceDate) continue;
        if (searchOpts.untilDate && rc.created_at >= searchOpts.untilDate) continue;
        rc._semanticSim = simMap.get(rc.id) || 0;
        rc._normalizedFts = rc._semanticSim * 0.3; // cosine-weighted partial credit (0.3 to avoid noise outranking FTS hits)
        rc.rank = 0;
        results.push(rc);
        rescuedCount++;
      }
      totalFetched += rescuedCount;
    }
  }

  // Tag entity matches (after rescue merge so rescued chunks get tagged too)
  for (const r of results) {
    if (matchedEntities.size > 0) {
      try {
        const entities = JSON.parse(r.entities || '[]');
        r._entityMatch = entities.some(e =>
          matchedEntities.has(e.toLowerCase().replace(/^@/, ''))
        );
      } catch (_) {
        r._entityMatch = false;
      }
    } else {
      r._entityMatch = false;
    }
  }

  // Apply config-level fileWeight overrides (before scoring)
  if (fileWeights && typeof fileWeights === 'object' && Object.keys(fileWeights).length > 0) {
    for (const r of results) {
      const override = resolveFileWeight(r.file_path, fileWeights);
      if (override != null) r.file_weight = override;
    }
  }

  // Score and rank with per-query profile
  const nowMs = Date.now();
  for (const r of results) {
    r._cilScore = cilScore(r, nowMs, { recencyBoostDays: effectiveRecencyBoost, profile: activeProfile });
  }

  // Temporal date boost — promote chunks matching resolved dates
  if (temporal.dateTerms.length > 0) {
    for (const r of results) {
      const pathDate = (r.file_path || '').match(/(\d{4}-\d{2}-\d{2})/);
      const createdDate = r.created_at ? r.created_at.split('T')[0] : null;
      if (pathDate && temporal.dateTerms.includes(pathDate[1])) {
        r._cilScore *= 1.8; // exact date match in path
      } else if (pathDate && temporal.since && temporal.until) {
        const sinceDay = temporal.since.split('T')[0];
        const untilDay = temporal.until.split('T')[0];
        if (pathDate[1] >= sinceDay && pathDate[1] < untilDay) {
          r._cilScore *= 1.3; // range match in path
        }
      } else if (createdDate && temporal.dateTerms.includes(createdDate)) {
        r._cilScore *= 1.5; // created_at date match
      }
    }
  }

  // Intent-based type boost — promote chunk types relevant to query intent
  if (intent && intent.typeBoosts) {
    for (const r of results) {
      const boost = intent.typeBoosts[r.chunk_type];
      if (boost) r._cilScore *= (1 + boost); // e.g. decision: 0.25 → 1.25x
    }
  }

  // Priority file injection — for action intent, bypass FTS to guarantee
  // key files (open-loops.md, self-review) appear with minimum score floor
  results = injectPriorityFiles(db, intent, results, effectiveExclusions, confidenceFloor);

  // Rule chunk penalty — suppress rule/policy noise for factual recall queries
  applyRulePenalty(results, intent, message);

  results.sort((a, b) => b._cilScore - a._cilScore);

  // Drop low-scoring chunks — better 2 high-quality than 5 mediocre
  if (minCilScore > 0) {
    results = results.filter(r => r._cilScore >= minCilScore);
  }

  // Cap to maxChunks
  results = results.slice(0, maxChunks);

  // Map to CILChunk shape
  const cilChunks = results.map(r => ({
    id: r.id,
    content: r.content,
    filePath: r.file_path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    heading: r.heading || null,
    confidence: r.confidence != null ? r.confidence : 1.0,
    chunkType: r.chunk_type || 'raw',
    entities: (() => { try { return JSON.parse(r.entities || '[]'); } catch (_) { return []; } })(),
    date: r.created_at || null,
    cilScore: r._cilScore,
  }));

  // Token budgeting
  let budgeted = budgetChunks(cilChunks, maxTokens);

  // Contradiction detection within results
  let contradictions = [];
  if (flagContradictions && budgeted.length >= 2) {
    contradictions = findContradictionsInResults(db, budgeted);
  }

  // Format output + enforce budget ceiling (guards against estimation drift)
  let text = formatContext(budgeted, contradictions);
  let tokenEstimate = Math.ceil(text.length / 3.5);
  while (tokenEstimate > maxTokens && budgeted.length > 1) {
    budgeted = budgeted.slice(0, -1);
    contradictions = (flagContradictions && budgeted.length >= 2)
      ? findContradictionsInResults(db, budgeted) : [];
    text = formatContext(budgeted, contradictions);
    tokenEstimate = Math.ceil(text.length / 3.5);
  }

  // Log recall event
  if (workspace) {
    try {
      logRecall(workspace, {
        query: message,
        queryTerms: [...contextTerms],
        chunksReturned: budgeted.length,
        chunksDropped: totalFetched - budgeted.length,
        excludedByPattern,
        tokenEstimate,
        chunks: budgeted,
        durationMs: Date.now() - startMs,
      });
    } catch (_) {}
  }

  return { text, chunks: budgeted, tokenEstimate };
}

function invalidateEntityCache() {
  _entityCache = null;
  _entityCacheTime = 0;
}

module.exports = { getRelevantContext, extractQueryTerms, cilScore, budgetChunks, formatContext, invalidateEntityCache, detectQueryIntent, isRuleChunk, applyRulePenalty };
