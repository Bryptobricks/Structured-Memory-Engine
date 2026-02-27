'use strict';

const { search } = require('./store');
const { extractTerms } = require('./reflect');
const { sanitizeFtsQuery, buildOrQuery } = require('./recall');
const { loadAliases } = require('./recall');
const { expandEntitiesWithCooccurrence } = require('./entities');
const { cosineSimilarity } = require('./embeddings');

// Entity cache — rebuilt at most once per ENTITY_CACHE_TTL
let _entityCache = null;
let _entityCacheTime = 0;
const ENTITY_CACHE_TTL = 60000; // 1 minute

const TYPE_BONUS = {
  confirmed: 0.15,
  decision: 0.12,
  preference: 0.10,
  fact: 0.08,
  opinion: 0.04,
  inferred: 0.0,
  outdated: -0.15,
  raw: 0.0,
};

function extractQueryTerms(message) {
  const terms = extractTerms(message);

  // Preserve capitalized terms that look like proper nouns (e.g., "JB", "Echelon")
  const properNouns = message.match(/\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*\b/g) || [];
  for (const pn of properNouns) {
    const lower = pn.toLowerCase();
    if (lower.length >= 2 && !terms.includes(lower)) {
      terms.push(lower);
    }
  }

  return terms;
}

function cilScore(chunk, nowMs, opts) {
  const confidence = chunk.confidence != null ? chunk.confidence : 1.0;

  // Recency — exponential decay with configurable half-life
  const created = chunk.created_at ? new Date(chunk.created_at).getTime() : 0;
  const daysAgo = Math.max(0, (nowMs - created) / 86400000);
  const recencyBoostDays = opts.recencyBoostDays || 30;
  const recency = Math.exp(-0.693 * daysAgo / recencyBoostDays);

  // Type priority
  const typeBonus = TYPE_BONUS[chunk.chunk_type] || 0;

  // File weight
  const fileWeight = chunk.file_weight || 1.0;

  // Entity match bonus (set by caller)
  const entityMatch = chunk._entityMatch ? 1 : 0;

  // Semantic similarity (optional — 0 when embeddings not available)
  const semantic = chunk._semanticSim || 0;

  // Base score — weights shift when semantic signal is available
  let baseScore;
  if (semantic > 0) {
    // With embeddings: FTS drops, semantic fills the gap
    baseScore =
      0.25 * (chunk._normalizedFts || 0) +
      0.25 * semantic +
      0.20 * recency +
      0.15 * (typeBonus + 0.15) / 0.30 +
      0.075 * (fileWeight / 1.5) +
      0.075 * entityMatch;
  } else {
    // Without embeddings: original weights
    baseScore =
      0.45 * (chunk._normalizedFts || 0) +
      0.25 * recency +
      0.15 * (typeBonus + 0.15) / 0.30 +
      0.075 * (fileWeight / 1.5) +
      0.075 * entityMatch;
  }

  // Confidence as multiplier — pow(1.5) makes low-confidence facts drop faster
  // conf 1.0 → 1.0, conf 0.6 → 0.465, conf 0.3 → 0.164
  return baseScore * Math.pow(confidence, 1.5);
}

function normalizeFtsScores(results) {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0]._normalizedFts = 1.0;
    return;
  }
  const ranks = results.map(r => r.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const range = maxRank - minRank || 1;
  for (const r of results) {
    // Floor at 0.3 so FTS doesn't completely dominate when range is narrow
    r._normalizedFts = 0.3 + 0.7 * (maxRank - r.rank) / range;
  }
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
          const truncated = chunk.content.slice(0, truncatedChars) + '…';
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
 * @returns {{ text: string, chunks: Array<CILChunk>, tokenEstimate: number }}
 */
function getRelevantContext(db, message, opts = {}) {
  const {
    maxTokens = 1500,
    maxChunks = 10,
    confidenceFloor = 0.2,
    recencyBoostDays = 30,
    workspace = null,
    flagContradictions = true,
    conversationContext = [],
    queryEmbedding = null,
  } = opts;

  if (!message || !message.trim()) {
    return { text: '', chunks: [], tokenEstimate: 0 };
  }

  const terms = extractQueryTerms(message);
  if (terms.length === 0) {
    return { text: '', chunks: [], tokenEstimate: 0 };
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
  const fetchLimit = maxChunks * 2;
  const searchOpts = { limit: fetchLimit, minConfidence: confidenceFloor };
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
  if (results.length === 0) {
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

  return { text, chunks: budgeted, tokenEstimate };
}

function invalidateEntityCache() {
  _entityCache = null;
  _entityCacheTime = 0;
}

module.exports = { getRelevantContext, extractQueryTerms, cilScore, budgetChunks, formatContext, invalidateEntityCache };
