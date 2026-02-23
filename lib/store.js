const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  entities TEXT,
  chunk_type TEXT DEFAULT 'raw',
  confidence REAL DEFAULT 1.0,
  created_at TEXT,
  indexed_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, heading, entities,
  content=chunks,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, heading, entities)
  VALUES (new.id, new.content, new.heading, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, heading, entities)
  VALUES ('delete', old.id, old.content, old.heading, old.entities);
END;

CREATE TABLE IF NOT EXISTS files (
  file_path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
`;

function openDb(workspace) {
  const dir = path.join(workspace, '.memory');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'index.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // Migrations: add columns if missing (safe no-op if already exist)
  try { db.exec('ALTER TABLE chunks ADD COLUMN file_weight REAL DEFAULT 1.0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN last_accessed TEXT'); } catch (_) {}
  return db;
}

function getFileMeta(db, filePath) {
  return db.prepare('SELECT * FROM files WHERE file_path = ?').get(filePath);
}

function deleteFileChunks(db, filePath) {
  db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
  db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);
}

const FILE_WEIGHTS = {
  'MEMORY.md': 1.5,
  'USER.md': 1.3,
  'SOUL.md': 1.2,
  'TOOLS.md': 1.1,
  'IDENTITY.md': 1.1,
  'STATE.md': 1.2,
  'VOICE.md': 1.1,
};

function getFileWeight(filePath) {
  const basename = path.basename(filePath);
  if (FILE_WEIGHTS[basename]) return FILE_WEIGHTS[basename];
  if (filePath.includes('self-review')) return 0.8;
  return 1.0;
}

function insertChunks(db, filePath, mtimeMs, chunks, createdAt) {
  const now = new Date().toISOString();
  const weight = getFileWeight(filePath);
  const insert = db.prepare(`
    INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, 'raw', 1.0, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    deleteFileChunks(db, filePath);
    for (const c of chunks) {
      insert.run(filePath, c.heading || null, c.content, c.lineStart, c.lineEnd, JSON.stringify(c.entities), createdAt || now, now, weight);
    }
    db.prepare(`INSERT OR REPLACE INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, ?, ?)`)
      .run(filePath, mtimeMs, chunks.length, now);
  });
  tx();
}

function search(db, query, { limit = 10, sinceDate = null } = {}) {
  let sql = `
    SELECT c.*, chunks_fts.rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
  `;
  const params = [query];
  const conditions = ['chunks_fts MATCH ?'];
  if (sinceDate) {
    conditions.push('c.created_at >= ?');
    params.push(sinceDate);
  }
  sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY chunks_fts.rank LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getAdjacentChunks(db, filePath, lineStart, lineEnd, n) {
  // Get N chunks before and after from the same file, ordered by line_start
  const all = db.prepare(
    'SELECT * FROM chunks WHERE file_path = ? ORDER BY line_start'
  ).all(filePath);
  const idx = all.findIndex(c => c.line_start === lineStart && c.line_end === lineEnd);
  if (idx === -1) return [];
  const before = all.slice(Math.max(0, idx - n), idx);
  const after = all.slice(idx + 1, idx + 1 + n);
  const fmt = c => ({ content: c.content, heading: c.heading, lineStart: c.line_start, lineEnd: c.line_end });
  return [...before.map(fmt), ...after.map(fmt)];
}

function getStats(db) {
  const fileCount = db.prepare('SELECT COUNT(*) as n FROM files').get().n;
  const chunkCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
  const files = db.prepare('SELECT file_path, chunk_count, indexed_at FROM files ORDER BY indexed_at DESC').all();
  return { fileCount, chunkCount, files };
}

module.exports = { openDb, getFileMeta, deleteFileChunks, insertChunks, search, getAdjacentChunks, getStats };
