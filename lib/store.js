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
  return db;
}

function getFileMeta(db, filePath) {
  return db.prepare('SELECT * FROM files WHERE file_path = ?').get(filePath);
}

function deleteFileChunks(db, filePath) {
  db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
  db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);
}

function insertChunks(db, filePath, mtimeMs, chunks, createdAt) {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'raw', 1.0, ?, ?)
  `);

  const tx = db.transaction(() => {
    deleteFileChunks(db, filePath);
    for (const c of chunks) {
      insert.run(filePath, c.heading || null, c.content, c.lineStart, c.lineEnd, JSON.stringify(c.entities), createdAt || now, now);
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

function getStats(db) {
  const fileCount = db.prepare('SELECT COUNT(*) as n FROM files').get().n;
  const chunkCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
  const files = db.prepare('SELECT file_path, chunk_count, indexed_at FROM files ORDER BY indexed_at DESC').all();
  return { fileCount, chunkCount, files };
}

module.exports = { openDb, getFileMeta, deleteFileChunks, insertChunks, search, getStats };
