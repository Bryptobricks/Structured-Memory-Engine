const { search, getAdjacentChunks } = require('./store');
const { score: computeScore, normalizeFtsScores, RECALL_PROFILE } = require('./scoring');
const { isExcludedFromRecall } = require('./config');
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
    .map(t => t.replace(/['']s$/i, '').replace(/["""''?!.,;:()[\]{}]/g, ''))
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()));
  if (terms.length === 0) return null;
  return terms.map(t => '"' + t + '"').join(' ');
}

function buildOrQuery(query, aliases) {
  if (!query || !query.trim()) return null;
  const rawTerms = query.split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/['']s$/i, '').replace(/["""''?!.,;:()[\]{}]/g, ''))
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

function rankResults(rows) {
  if (rows.length === 0) return [];
  const nowMs = Date.now();
  // Normalize FTS5 ranks to 0-1 range for the shared scorer
  normalizeFtsScores(rows);
  return rows.map(r => {
    const finalScore = computeScore(r, nowMs, RECALL_PROFILE);
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
      entities: JSON.parse(r.entities || '[]'),
      date: r.created_at
    };
  }).sort((a, b) => b.finalScore - a.finalScore); // higher = better
}

function recall(db, query, { limit = 10, since = null, context = 0, workspace = null, chunkType = null, minConfidence = null, includeStale = false, excludeFromRecall: excludePatterns = null } = {}) {
  const aliases = loadAliases(workspace);
  const sinceDate = parseSince(since);
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const searchOpts = { limit, sinceDate, chunkType, minConfidence, includeStale };
  try {
    let rows = search(db, sanitized, searchOpts);
    // OR fallback with alias expansion if AND query returns nothing
    if (rows.length === 0) {
      const orQuery = buildOrQuery(query, aliases);
      if (orQuery) {
        rows = search(db, orQuery, searchOpts);
      }
    }
    // Filter out excluded files before ranking
    if (excludePatterns && excludePatterns.length > 0) {
      rows = rows.filter(r => !isExcludedFromRecall(r.file_path, excludePatterns));
    }
    const results = rankResults(rows);
    // Improvement 3: cross-chunk context window
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
