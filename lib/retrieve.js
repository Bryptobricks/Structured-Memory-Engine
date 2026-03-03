'use strict';

/**
 * lib/retrieve.js — Shared retrieval pipeline used by both recall() and getRelevantContext().
 *
 * Runs the full FTS + semantic + rescue pipeline:
 * 1. Temporal resolution
 * 2. Intent detection
 * 3. FTS dual-query (AND + OR with aliases)
 * 4. Exclusion filtering
 * 5. AND-match boost (1.3x)
 * 6. FTS score normalization
 * 7. Semantic enrichment (cosine sim on FTS results)
 * 8. Rescue pass (scan all embeddings for high-sim misses)
 *
 * Returns raw rows with _andMatch, _semanticSim, _normalizedFts annotations.
 * Callers (recall/context) apply their own post-processing (scoring, budgeting, formatting).
 */

const { search } = require('./store');
const { isExcludedFromRecall } = require('./config');
const { cosineSimilarity } = require('./embeddings');
const { normalizeFtsScores } = require('./scoring');
const { resolveTemporalQuery } = require('./temporal');
const { detectQueryIntent } = require('./query-features');
const path = require('path');
const fs = require('fs');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'i', 'me', 'my', 'mine', 'we', 'our', 'you', 'your', 'he', 'she',
  'it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'during', 'before', 'after', 'above', 'below', 'up', 'down',
  'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
  'and', 'but', 'or', 'nor', 'not', 'no', 'so', 'if', 'when', 'where',
  'how', 'what', 'which', 'who', 'whom', 'why', 'there', 'here',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
  'just', 'also', 'very', 'too', 'only', 'now', 'currently', 'today',
  'right', 'going', 'taking', 'tell', 'think', 'know', 'like', 'want',
  'need', 'get', 'got', 'make', 'made', 'go', 'come', 'see', 'look',
  'give', 'take', 'say', 'said', 'ok', 'okay', 'yes', 'yeah',
]);

// Default alias map for query expansion (users can override via aliases.json in .memory/)
const DEFAULT_ALIASES = {
  // --- Crypto / DeFi ---
  'ca': ['contract address', 'token'],
  'contract address': ['ca', 'token'],
  'dex': ['swap', 'exchange', 'uniswap', 'sushiswap'],
  'swap': ['dex', 'exchange', 'trade'],
  'exchange': ['dex', 'swap', 'cex'],
  'yield': ['apy', 'apr', 'farming', 'reward'],
  'apy': ['yield', 'apr', 'farming'],
  'apr': ['yield', 'apy', 'rate'],
  'farming': ['yield', 'apy', 'liquidity'],
  'defi': ['protocol', 'dapp', 'crypto'],
  'protocol': ['defi', 'dapp'],
  'wallet': ['address', 'account', 'funds'],
  'address': ['wallet', 'account'],
  'stablecoin': ['usdc', 'usdt', 'dai', 'stable'],
  'usdc': ['stablecoin', 'usdt', 'dai'],
  'usdt': ['stablecoin', 'usdc', 'dai'],
  'dai': ['stablecoin', 'usdc', 'usdt'],
  'leverage': ['borrow', 'loan', 'collateral', 'margin'],
  'borrow': ['leverage', 'loan', 'debt'],
  'loan': ['leverage', 'borrow', 'debt'],
  'collateral': ['leverage', 'deposit', 'supply'],
  'airdrop': ['claim', 'drop', 'distribution'],
  'bridge': ['cross-chain', 'transfer', 'bridge'],
  'stake': ['staking', 'validator', 'delegate'],
  'staking': ['stake', 'validator', 'delegate'],
  'liquidation': ['health factor', 'margin call', 'liq'],
  'crypto': ['defi', 'token', 'chain', 'wallet', 'web3'],
  'token': ['coin', 'crypto', 'asset'],
  'nft': ['collectible', 'mint'],
  'gas': ['fee', 'gwei', 'transaction cost'],
  // --- Health ---
  'supplement': ['stack', 'protocol', 'nootropic'],
  'stack': ['supplement', 'protocol', 'regimen'],
  'peptide': ['injection', 'dose', 'compound'],
  'injection': ['peptide', 'dose', 'shot'],
  'weight': ['lbs', 'body composition', 'scale'],
  'lbs': ['weight', 'pounds', 'body composition'],
  'sleep': ['rest', 'recovery', 'circadian'],
  'blood': ['labs', 'bloodwork', 'panel'],
  'labs': ['blood', 'bloodwork', 'panel', 'test'],
  'bloodwork': ['blood', 'labs', 'panel'],
  'diet': ['nutrition', 'food', 'calories', 'macros'],
  'nutrition': ['diet', 'food', 'calories'],
  'calories': ['diet', 'nutrition', 'food', 'tdee'],
  'health': ['medical', 'blood', 'labs', 'protocol', 'wellness'],
  'dose': ['dosage', 'mg', 'amount'],
  'dosage': ['dose', 'mg', 'amount'],
  // --- Dev ---
  'deploy': ['ship', 'release', 'push', 'publish'],
  'ship': ['deploy', 'release', 'launch'],
  'release': ['deploy', 'ship', 'version'],
  'bug': ['fix', 'issue', 'error', 'defect'],
  'fix': ['bug', 'patch', 'resolve'],
  'issue': ['bug', 'error', 'problem', 'ticket'],
  'error': ['bug', 'exception', 'crash'],
  'refactor': ['cleanup', 'rewrite', 'restructure'],
  'test': ['spec', 'assertion', 'unit test'],
  'api': ['endpoint', 'route', 'rest'],
  'endpoint': ['api', 'route', 'url'],
  'database': ['db', 'sqlite', 'postgres', 'sql'],
  'db': ['database', 'sqlite', 'postgres'],
  'config': ['configuration', 'settings', 'env'],
  'dependency': ['package', 'module', 'library'],
  // --- Personal ---
  'remember': ['memory', 'recall', 'memorize'],
  'memory': ['remember', 'recall', 'stored'],
  'decision': ['chose', 'decided', 'picked', 'choice'],
  'preference': ['prefer', 'like', 'want', 'favorite'],
  'project': ['repo', 'codebase', 'app'],
  'person': ['contact', 'people', 'who'],
  'goal': ['target', 'objective', 'aim'],
  // --- Finance ---
  'money': ['funds', 'capital', 'portfolio', 'wallet'],
  'profit': ['gain', 'return', 'pnl', 'earnings'],
  'loss': ['drawdown', 'deficit', 'negative'],
  'risk': ['exposure', 'hedge', 'de-risk'],
  // --- General ---
  'job': ['work', 'career', 'employment'],
  'work': ['job', 'career', 'employment', 'task'],
  'home': ['apartment', 'bedroom', 'living'],
  'plan': ['strategy', 'roadmap', 'approach'],
  'idea': ['concept', 'thought', 'proposal'],
};

function loadAliases(workspace) {
  if (!workspace) return DEFAULT_ALIASES;
  const aliasPath = path.join(workspace, '.memory', 'aliases.json');
  try {
    if (fs.existsSync(aliasPath)) {
      const custom = JSON.parse(fs.readFileSync(aliasPath, 'utf-8'));
      // Shallow merge: custom keys replace defaults (not extend). This is intentional —
      // define the full alias array per key if overriding.
      return { ...DEFAULT_ALIASES, ...custom };
    }
  } catch (err) {
    console.warn(`⚠️  Failed to parse aliases.json: ${err.message} — using defaults`);
  }
  return DEFAULT_ALIASES;
}

function sanitizeFtsQuery(query) {
  if (!query || !query.trim()) return null;
  // Strip FTS5 operators for implicit AND query (operators break FTS5 syntax)
  let q = query.replace(/\b(AND|OR|NOT|NEAR)\b/g, '');
  // Split, strip possessives/punctuation, filter stop words
  const terms = q.split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/[''\u2019]s$/i, '').replace(/["""\u201C\u201D''\u2018\u2019?!.,;:()[\]{}]/g, ''))
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()));
  if (terms.length === 0) return null;
  return terms.map(t => '"' + t + '"').join(' ');
}

function buildOrQuery(query, aliases) {
  if (!query || !query.trim()) return null;
  const rawTerms = query.split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/[''\u2019]s$/i, '').replace(/["""\u201C\u201D''\u2018\u2019?!.,;:()[\]{}]/g, ''))
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()));
  if (rawTerms.length === 0) return null;
  // Expand with aliases
  const allTerms = new Set(rawTerms);
  for (const term of rawTerms) {
    const key = term.toLowerCase();
    if (aliases[key]) {
      for (const alias of aliases[key]) allTerms.add(alias);
    }
  }
  const quoted = [...allTerms].map(t => '"' + t + '"');
  return quoted.length ? quoted.join(' OR ') : null;
}

function parseSince(since) {
  if (!since) return null;
  // Absolute date
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) return since;
  // Relative: Nd, Nw, Nm, Ny
  const m = since.match(/^(\d+)([dwmy])$/);
  if (m) {
    const n = parseInt(m[1]);
    const unit = m[2];
    const d = new Date();
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - n * 7);
    else if (unit === 'm') d.setDate(d.getDate() - n * 30);
    else if (unit === 'y') d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  }
  return null;
}

/**
 * retrieveChunks — shared retrieval pipeline for recall() and getRelevantContext().
 *
 * Runs FTS dual-query, exclusion filtering, AND-match boost, FTS normalization,
 * semantic enrichment, and rescue pass. Returns annotated rows for callers to
 * score and post-process with their own logic.
 *
 * @param {Database} db - better-sqlite3 handle from store.openDb()
 * @param {string} query - the user's query (raw text)
 * @param {object} [opts]
 * @param {number} [opts.limit=30] - FTS fetch limit (rows per search call)
 * @param {string} [opts.workspace=null] - workspace path for alias loading
 * @param {Float32Array} [opts.queryEmbedding=null] - pre-computed query embedding
 * @param {string[]} [opts.excludePatterns=null] - file path patterns to exclude
 * @param {string} [opts.sinceDate=null] - pre-parsed since date (ISO string)
 * @param {string} [opts.untilDate=null] - until date (ISO string)
 * @param {string} [opts.chunkType=null] - filter by chunk type
 * @param {number} [opts.minConfidence=null] - minimum confidence threshold
 * @param {boolean} [opts.includeStale=false] - include stale chunks
 * @param {number} [opts.rescueMinSim=0.25] - minimum cosine similarity for rescue
 * @param {number} [opts.rescueMax=5] - max rescued chunks
 * @param {string} [opts.orInput=null] - override OR query input (e.g. expanded context terms)
 * @param {Array} [opts.extraOrQueries=[]] - additional OR queries [{query, opts?}]
 * @param {object} [opts.temporal=null] - pre-computed temporal resolution
 * @param {object} [opts.intent=null] - pre-computed query intent
 * @returns {{ rows: Array, temporal: object, intent: object, totalFetched: number }}
 */
function retrieveChunks(db, query, opts = {}) {
  const {
    limit = 30,
    workspace = null,
    queryEmbedding = null,
    excludePatterns = null,
    sinceDate = null,
    untilDate = null,
    chunkType = null,
    minConfidence = null,
    includeStale = false,
    rescueMinSim = 0.25,
    rescueMax = 5,
    orInput = null,
    extraOrQueries = [],
    temporal: precomputedTemporal = null,
    intent: precomputedIntent = null,
  } = opts;

  // Step 1: Temporal + Intent (use pre-computed if provided)
  const temporal = precomputedTemporal || resolveTemporalQuery(query);
  const intent = precomputedIntent || detectQueryIntent(query);
  const queryForFts = temporal.strippedQuery || query;

  // Step 2: Override dates from temporal
  let effectiveSince = sinceDate;
  let effectiveUntil = untilDate;
  if (temporal.since) effectiveSince = temporal.since;
  if (temporal.until) effectiveUntil = temporal.until;

  const sanitized = sanitizeFtsQuery(queryForFts);

  // Step 3: Date-range fallback — when FTS sanitizes to empty but temporal dates exist
  if (!sanitized && temporal.dateTerms.length > 0) {
    try {
      let sql = 'SELECT * FROM chunks WHERE 1=1';
      const params = [];
      if (!includeStale) { sql += ' AND stale = 0'; }
      if (effectiveSince) { sql += ' AND created_at >= ?'; params.push(effectiveSince); }
      if (effectiveUntil) { sql += ' AND created_at < ?'; params.push(effectiveUntil); }
      if (chunkType) { sql += ' AND chunk_type = ?'; params.push(chunkType); }
      if (minConfidence != null) { sql += ' AND confidence >= ?'; params.push(minConfidence); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      let rows = db.prepare(sql).all(...params);
      for (const r of rows) r.rank = 0;
      if (excludePatterns && excludePatterns.length > 0) {
        rows = rows.filter(r => !isExcludedFromRecall(r.file_path, excludePatterns));
      }
      return { rows, temporal, intent, totalFetched: rows.length };
    } catch (e) {
      return { rows: [], temporal, intent, totalFetched: 0 };
    }
  }

  // No search path available: no FTS terms, no orInput, no extra queries, no embedding
  if (!sanitized && !orInput && extraOrQueries.length === 0 && !queryEmbedding) {
    return { rows: [], temporal, intent, totalFetched: 0 };
  }

  const searchOpts = { limit, sinceDate: effectiveSince, untilDate: effectiveUntil, chunkType, minConfidence, includeStale };

  try {
    const seen = new Map();
    const aliases = loadAliases(workspace);

    // Step 4: FTS dual-query (AND for precision, OR with aliases for recall)
    if (sanitized) {
      const andRows = search(db, sanitized, searchOpts);
      for (const r of andRows) { r._andMatch = true; seen.set(r.id, r); }
    }

    // OR query — runs independently of AND (orInput may have expanded terms even when raw query sanitizes to null)
    const orQueryInput = orInput || (sanitized ? queryForFts : null);
    if (orQueryInput) {
      const orQ = buildOrQuery(orQueryInput, aliases);
      if (orQ) {
        const orRows = search(db, orQ, searchOpts);
        for (const r of orRows) {
          if (!seen.has(r.id)) { r._andMatch = false; seen.set(r.id, r); }
        }
      }
    }

    // Extra OR queries (date terms, forward-looking, etc.)
    for (const eq of extraOrQueries) {
      try {
        const eqOpts = eq.opts || searchOpts;
        const eqRows = search(db, eq.query, eqOpts);
        for (const r of eqRows) { if (!seen.has(r.id)) seen.set(r.id, r); }
      } catch (_) {}
    }

    let rows = [...seen.values()];
    const totalFetched = rows.length;

    // Step 5: Exclusion filtering
    if (excludePatterns && excludePatterns.length > 0) {
      rows = rows.filter(r => !isExcludedFromRecall(r.file_path, excludePatterns));
    }

    // Step 6: AND-match boost + FTS normalization
    for (const r of rows) { if (r._andMatch) r.rank *= 1.3; }
    normalizeFtsScores(rows);

    // Step 7: Semantic enrichment (if queryEmbedding provided)
    const ftsIds = new Set(rows.map(r => r.id));

    if (queryEmbedding && queryEmbedding.length > 0) {
      // Enrich FTS results with cosine similarity
      if (ftsIds.size > 0) {
        const idList = [...ftsIds];
        const placeholders = idList.map(() => '?').join(',');
        let embRows = [];
        try {
          embRows = db.prepare(`SELECT id, embedding FROM chunks WHERE id IN (${placeholders}) AND embedding IS NOT NULL`).all(...idList);
        } catch (_) {}
        const embMap = new Map();
        for (const row of embRows) {
          const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
          embMap.set(row.id, vec);
        }
        for (const r of rows) {
          const stored = embMap.get(r.id);
          r._semanticSim = stored ? cosineSimilarity(queryEmbedding, stored) : 0;
        }
      }

      // Step 8: Rescue pass — scan all embedded chunks for high-similarity misses
      let allEmbedded = [];
      try {
        const staleClause = includeStale ? '' : ' AND stale = 0';
        allEmbedded = db.prepare(`SELECT * FROM chunks WHERE embedding IS NOT NULL${staleClause}`).all();
      } catch (_) {}

      const rescueCandidates = [];
      for (const row of allEmbedded) {
        if (ftsIds.has(row.id)) continue;

        const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        const sim = cosineSimilarity(queryEmbedding, vec);
        if (sim < rescueMinSim) continue;

        // Apply same filters as FTS path
        if (effectiveSince && row.created_at < effectiveSince) continue;
        if (effectiveUntil && row.created_at >= effectiveUntil) continue;
        if (chunkType && row.chunk_type !== chunkType) continue;
        if (minConfidence != null && row.confidence < minConfidence) continue;
        if (excludePatterns && excludePatterns.length > 0 && isExcludedFromRecall(row.file_path, excludePatterns)) continue;

        row.rank = 0;
        row._normalizedFts = sim * 0.3;
        row._semanticSim = sim;
        rescueCandidates.push(row);
      }
      rescueCandidates.sort((a, b) => b._semanticSim - a._semanticSim);
      for (const row of rescueCandidates.slice(0, rescueMax)) {
        rows.push(row);
        ftsIds.add(row.id);
      }
    }

    return { rows, temporal, intent, totalFetched };
  } catch (e) {
    // Bad FTS5 query — return empty rather than crash
    return { rows: [], temporal, intent, totalFetched: 0 };
  }
}

module.exports = {
  STOP_WORDS,
  DEFAULT_ALIASES,
  loadAliases,
  sanitizeFtsQuery,
  buildOrQuery,
  parseSince,
  retrieveChunks,
};
