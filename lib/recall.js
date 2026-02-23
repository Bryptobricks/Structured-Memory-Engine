const { search, getAdjacentChunks } = require('./store');
const path = require('path');
const fs = require('fs');

// Default alias map for query expansion (users can override via aliases.json in .memory/)
const DEFAULT_ALIASES = {
  'job': ['work', 'career', 'employment'],
  'work': ['job', 'career', 'movement'],
  'money': ['funds', 'capital', 'portfolio', 'wallet'],
  'health': ['medical', 'blood', 'labs', 'protocol'],
  'home': ['apartment', 'bedroom', 'living'],
  'crypto': ['defi', 'token', 'chain', 'wallet'],
};

function loadAliases(workspace) {
  if (!workspace) return DEFAULT_ALIASES;
  const aliasPath = path.join(workspace, '.memory', 'aliases.json');
  try {
    if (fs.existsSync(aliasPath)) {
      const custom = JSON.parse(fs.readFileSync(aliasPath, 'utf-8'));
      return { ...DEFAULT_ALIASES, ...custom };
    }
  } catch (_) {}
  return DEFAULT_ALIASES;
}

let ALIASES = DEFAULT_ALIASES;

function sanitizeFtsQuery(query) {
  if (!query || !query.trim()) return null;
  // Strip FTS5 operators
  let q = query.replace(/\b(AND|OR|NOT|NEAR)\b/g, '');
  // Split into terms, escape quotes, wrap each in double quotes
  const terms = q.split(/\s+/).filter(Boolean).map(t => '"' + t.replace(/"/g, '') + '"');
  return terms.length ? terms.join(' ') : null;
}

function buildOrQuery(query) {
  if (!query || !query.trim()) return null;
  let q = query.replace(/\b(AND|OR|NOT|NEAR)\b/g, '');
  const rawTerms = q.split(/\s+/).filter(Boolean).map(t => t.replace(/"/g, ''));
  // Expand with aliases
  const allTerms = new Set(rawTerms);
  for (const term of rawTerms) {
    const key = term.toLowerCase();
    if (ALIASES[key]) {
      for (const alias of ALIASES[key]) allTerms.add(alias);
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
  const now = Date.now();
  return rows.map(r => {
    const ftsScore = r.rank;
    const fileWeight = r.file_weight || 1.0;
    let recencyBoost = 0;
    if (r.created_at) {
      const created = new Date(r.created_at).getTime();
      const daysAgo = (now - created) / (1000 * 60 * 60 * 24);
      recencyBoost = Math.max(0, 1 - (daysAgo / 90));
    }
    const finalScore = ftsScore * (1 + recencyBoost) * fileWeight;
    return {
      content: r.content,
      heading: r.heading,
      filePath: r.file_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      ftsScore,
      fileWeight,
      finalScore,
      score: finalScore,
      entities: JSON.parse(r.entities || '[]'),
      date: r.created_at
    };
  }).sort((a, b) => a.finalScore - b.finalScore); // FTS5 rank is negative, more negative = better
}

function recall(db, query, { limit = 10, since = null, context = 0, workspace = null } = {}) {
  ALIASES = loadAliases(workspace);
  const sinceDate = parseSince(since);
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  try {
    let rows = search(db, sanitized, { limit, sinceDate });
    // Improvement 1: OR fallback with alias expansion if AND query returns nothing
    if (rows.length === 0) {
      const orQuery = buildOrQuery(query);
      if (orQuery) {
        rows = search(db, orQuery, { limit, sinceDate });
      }
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

module.exports = { recall, parseSince, sanitizeFtsQuery, buildOrQuery };
