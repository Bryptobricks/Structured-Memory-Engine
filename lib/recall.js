const { search } = require('./store');

function sanitizeFtsQuery(query) {
  if (!query || !query.trim()) return null;
  // Strip FTS5 operators
  let q = query.replace(/\b(AND|OR|NOT|NEAR)\b/g, '');
  // Split into terms, escape quotes, wrap each in double quotes
  const terms = q.split(/\s+/).filter(Boolean).map(t => '"' + t.replace(/"/g, '') + '"');
  return terms.length ? terms.join(' ') : null;
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

function formatResults(rows) {
  return rows.map(r => ({
    content: r.content,
    heading: r.heading,
    filePath: r.file_path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    score: r.rank,
    entities: JSON.parse(r.entities || '[]'),
    date: r.created_at
  }));
}

function recall(db, query, { limit = 10, since = null } = {}) {
  const sinceDate = parseSince(since);
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  try {
    const rows = search(db, sanitized, { limit, sinceDate });
    return formatResults(rows);
  } catch (e) {
    // Bad FTS5 query — return empty rather than crash
    return [];
  }
}

module.exports = { recall, parseSince, sanitizeFtsQuery };
