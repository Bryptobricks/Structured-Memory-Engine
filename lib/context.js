'use strict';

const { search } = require('./store');
const { extractTerms } = require('./reflect');
const { sanitizeFtsQuery, buildOrQuery, loadAliases, STOP_WORDS } = require('./recall');
const { expandEntitiesWithCooccurrence } = require('./entities');
const { cosineSimilarity } = require('./embeddings');
const { score: computeScore, normalizeFtsScores, CIL_PROFILE, CIL_SEMANTIC_PROFILE } = require('./scoring');
const { isExcludedFromRecall } = require('./config');
const { logRecall } = require('./recall-logger');

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

function cilScore(chunk, nowMs, opts) {
  const hasSemantic = (chunk._semanticSim || 0) > 0;
  const profile = hasSemantic ? CIL_SEMANTIC_PROFILE : CIL_PROFILE;
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
    maxChunks = 10,
    confidenceFloor = 0.4,
    recencyBoostDays = 30,
    workspace = null,
    flagContradictions = true,
    conversationContext = [],
    queryEmbedding = null,
    excludeFromRecall: excludePatterns = null,
    minCilScore = 0.15,
  } = opts;

  if (!message || !message.trim()) {
    return { text: '', chunks: [], tokenEstimate: 0 };
  }

  const terms = extractQueryTerms(message);

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

  // Dual query: AND (precision) then OR with aliases (recall)
  const fetchLimit = maxChunks * 5;
  const searchOpts = { limit: fetchLimit, minConfidence: confidenceFloor, skipTracking: true };
  const seen = new Map(); // id → result

  // AND query
  const andQuery = sanitizeFtsQuery(message);
  if (andQuery) {
    try {
      const andRows = search(db, andQuery, searchOpts);
      for (const r of andRows) {
        r._andMatch = true;
        seen.set(r.id, r);
      }
    } catch (_) {}
  }

  // OR query with alias expansion (includes conversation context terms)
  let aliases = {};
  try { aliases = loadAliases(workspace); } catch (_) {}
  const orInput = contextTerms.size > terms.length
    ? [...contextTerms].join(' ')
    : message;
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

  let results = [...seen.values()];
  const totalFetched = results.length;

  // Filter out excluded files before scoring
  let excludedByPattern = 0;
  if (excludePatterns && excludePatterns.length > 0) {
    const before = results.length;
    results = results.filter(r => !isExcludedFromRecall(r.file_path, excludePatterns));
    excludedByPattern = before - results.length;
  }

  if (results.length === 0) {
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

  // Tag entity matches
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

  // Semantic similarity — sync cosine sim against pre-computed embeddings
  if (queryEmbedding && queryEmbedding.length > 0) {
    const ids = results.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    let embRows = [];
    try {
      embRows = db.prepare(`SELECT id, embedding FROM chunks WHERE id IN (${placeholders}) AND embedding IS NOT NULL`).all(...ids);
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

  // Score and rank
  const nowMs = Date.now();
  for (const r of results) {
    r._cilScore = cilScore(r, nowMs, { recencyBoostDays });
  }
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

module.exports = { getRelevantContext, extractQueryTerms, cilScore, budgetChunks, formatContext, invalidateEntityCache };
