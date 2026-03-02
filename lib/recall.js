const { search, getAdjacentChunks } = require('./store');
const { score: computeScore, normalizeFtsScores, RECALL_PROFILE, RECALL_SEMANTIC_PROFILE } = require('./scoring');
const { isExcludedFromRecall } = require('./config');
const { cosineSimilarity } = require('./embeddings');
const { resolveTemporalQuery } = require('./temporal');
const { detectQueryIntent, applyRulePenalty } = require('./query-features');
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

const RESCUE_MIN_SIM = 0.30;
const RESCUE_MAX = 10;

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

function rankResults(rows, profile = RECALL_PROFILE) {
  if (rows.length === 0) return [];
  const nowMs = Date.now();
  // Normalize FTS5 ranks to 0-1 range for the shared scorer
  normalizeFtsScores(rows);
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
      date: r.created_at
    };
  }).sort((a, b) => b.finalScore - a.finalScore); // higher = better
}

function applyTemporalBoost(results, temporal) {
  if (temporal.dateTerms.length === 0) return;
  for (const r of results) {
    const pathDate = (r.filePath || '').match(/(\d{4}-\d{2}-\d{2})/);
    const createdDate = r.date ? r.date.split('T')[0] : null;
    if (pathDate && temporal.dateTerms.includes(pathDate[1])) {
      r.score *= 1.8;
      r.finalScore *= 1.8;
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

function recall(db, query, { limit = 10, since = null, until = null, context = 0, workspace = null, chunkType = null, minConfidence = null, includeStale = false, excludeFromRecall: excludePatterns = null, queryEmbedding = null } = {}) {
  const aliases = loadAliases(workspace);

  // Temporal resolution — resolve "yesterday", "last week", etc.
  const temporal = resolveTemporalQuery(query);

  // Intent detection — adjust boosts for action/reasoning/aggregation queries
  const intent = detectQueryIntent(query);

  // Use stripped query for FTS (temporal phrases removed)
  const sanitized = sanitizeFtsQuery(temporal.strippedQuery || query);

  // Override since/until with temporal values
  let sinceDate = parseSince(since);
  let untilDate = until || null;
  if (temporal.since) sinceDate = temporal.since;
  if (temporal.until) untilDate = temporal.until;

  // Date-range fallback: when FTS query is empty but temporal markers exist
  if (!sanitized && temporal.dateTerms.length > 0) {
    try {
      let sql = 'SELECT * FROM chunks WHERE 1=1';
      const params = [];
      if (!includeStale) { sql += ' AND stale = 0'; }
      if (sinceDate) { sql += ' AND created_at >= ?'; params.push(sinceDate); }
      if (untilDate) { sql += ' AND created_at < ?'; params.push(untilDate); }
      if (chunkType) { sql += ' AND chunk_type = ?'; params.push(chunkType); }
      if (minConfidence != null) { sql += ' AND confidence >= ?'; params.push(minConfidence); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit * 3);
      let rows = db.prepare(sql).all(...params);

      // Set rank = 0 for non-FTS rows (normalization handles gracefully)
      for (const r of rows) r.rank = 0;

      if (excludePatterns && excludePatterns.length > 0) {
        rows = rows.filter(r => !isExcludedFromRecall(r.file_path, excludePatterns));
      }

      let results = rankResults(rows);
      applyTemporalBoost(results, temporal);
      applyIntentBoost(results, intent);
      applyRecallRulePenalty(results, intent, query);
      results.sort((a, b) => b.score - a.score);
      results = results.slice(0, limit);

      if (context > 0) {
        for (const r of results) {
          r.context = getAdjacentChunks(db, r.filePath, r.lineStart, r.lineEnd, context);
        }
      }
      return results;
    } catch (e) {
      return [];
    }
  }

  // Pure-semantic fallback: if FTS sanitization yields nothing but we have an embedding, skip FTS
  if (!sanitized && !queryEmbedding) return [];

  const fetchLimit = (queryEmbedding || temporal.dateTerms.length > 0 || intent) ? limit * 3 : limit;
  const searchOpts = { limit: fetchLimit, sinceDate, untilDate, chunkType, minConfidence, includeStale };
  const activeProfile = queryEmbedding ? RECALL_SEMANTIC_PROFILE : RECALL_PROFILE;

  try {
    let rows = [];

    // FTS search (skipped only when sanitized is null + queryEmbedding present)
    if (sanitized) {
      rows = search(db, sanitized, searchOpts);
      // OR fallback with alias expansion if AND query returns nothing
      if (rows.length === 0) {
        const orQuery = buildOrQuery(temporal.strippedQuery || query, aliases);
        if (orQuery) {
          rows = search(db, orQuery, searchOpts);
        }
      }
    }
    // Filter out excluded files before ranking
    if (excludePatterns && excludePatterns.length > 0) {
      rows = rows.filter(r => !isExcludedFromRecall(r.file_path, excludePatterns));
    }

    // Semantic enrichment + rescue pass
    if (queryEmbedding && queryEmbedding.length > 0) {
      // Enrich FTS results with semantic similarity
      const ftsIds = new Set(rows.map(r => r.id));
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

      // Rescue pass: scan all embedded chunks for high-similarity misses
      let allEmbedded = [];
      try {
        const staleClause = includeStale ? '' : ' AND stale = 0';
        allEmbedded = db.prepare(`SELECT id, embedding, file_path, heading, content, line_start, line_end, chunk_type, confidence, created_at, entities, file_weight, stale FROM chunks WHERE embedding IS NOT NULL${staleClause}`).all();
      } catch (_) {}

      let rescueCount = 0;
      for (const row of allEmbedded) {
        if (rescueCount >= RESCUE_MAX) break;
        if (ftsIds.has(row.id)) continue;

        const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        const sim = cosineSimilarity(queryEmbedding, vec);
        if (sim < RESCUE_MIN_SIM) continue;

        // Apply same filters as FTS path
        if (sinceDate && row.created_at < sinceDate) continue;
        if (untilDate && row.created_at >= untilDate) continue;
        if (chunkType && row.chunk_type !== chunkType) continue;
        if (minConfidence != null && row.confidence < minConfidence) continue;
        if (excludePatterns && excludePatterns.length > 0 && isExcludedFromRecall(row.file_path, excludePatterns)) continue;

        // Partial FTS credit for rescued chunks
        row.rank = 0;
        row._normalizedFts = sim * 0.3;
        row._semanticSim = sim;
        rows.push(row);
        ftsIds.add(row.id);
        rescueCount++;
      }
    }

    let results = rankResults(rows, activeProfile);

    // Post-ranking boosts
    applyTemporalBoost(results, temporal);
    applyIntentBoost(results, intent);
    applyRecallRulePenalty(results, intent, query);

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
  } catch (e) {
    // Bad FTS5 query — return empty rather than crash
    return [];
  }
}

module.exports = { recall, parseSince, sanitizeFtsQuery, buildOrQuery, rankResults, loadAliases, STOP_WORDS };
