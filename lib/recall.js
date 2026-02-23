const { search } = require('./store');

function parseSince(since) {
  if (!since) return null;
  // Absolute date
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) return since;
  // Relative: 7d, 30d, etc.
  const m = since.match(/^(\d+)d$/);
  if (m) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(m[1]));
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
  const rows = search(db, query, { limit, sinceDate });
  return formatResults(rows);
}

module.exports = { recall, parseSince };
