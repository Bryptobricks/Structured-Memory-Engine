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
  chunk_type TEXT DEFAULT 'raw',   -- v1: always 'raw'. v2 Retain: 'fact'|'confirmed'|'inferred'|'outdated'|'decision'|'preference'|'opinion'
  confidence REAL DEFAULT 1.0,    -- v1: always 1.0. v2 Retain: evidence-based scoring
  created_at TEXT,
  indexed_at TEXT NOT NULL
  -- Columns added via migration (see openDb):
  -- file_weight REAL DEFAULT 1.0       -- v1: ranking multiplier by file type
  -- access_count INTEGER DEFAULT 0     -- v2: frequency tracking (not yet active)
  -- last_accessed TEXT                  -- v2: recency tracking (not yet active)
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

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content, heading, entities ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, heading, entities)
  VALUES ('delete', old.id, old.content, old.heading, old.entities);
  INSERT INTO chunks_fts(rowid, content, heading, entities)
  VALUES (new.id, new.content, new.heading, new.entities);
END;

CREATE TABLE IF NOT EXISTS files (
  file_path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contradictions (
  id INTEGER PRIMARY KEY,
  chunk_id_old INTEGER NOT NULL,
  chunk_id_new INTEGER NOT NULL,
  reason TEXT,
  resolved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archived_chunks (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  entities TEXT,
  chunk_type TEXT,
  confidence REAL,
  created_at TEXT,
  indexed_at TEXT,
  file_weight REAL,
  access_count INTEGER,
  last_accessed TEXT,
  stale INTEGER,
  archived_at TEXT NOT NULL,
  archive_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
`;

function openDb(workspace) {
  const dir = path.join(workspace, '.memory');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'index.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // Migrations: add columns if missing (safe no-op if already exist)
  // file_weight: used in v1 for ranking (MEMORY.md > daily logs)
  // access_count + last_accessed: reserved for v2 frequency tracking (not yet active)
  try { db.exec('ALTER TABLE chunks ADD COLUMN file_weight REAL DEFAULT 1.0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN last_accessed TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE chunks ADD COLUMN stale INTEGER DEFAULT 0'); } catch (_) {}
  // Recreate UPDATE trigger to be column-specific (prevents FTS churn on access_count/confidence updates)
  try {
    db.exec('DROP TRIGGER IF EXISTS chunks_au');
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content, heading, entities ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading, entities) VALUES ('delete', old.id, old.content, old.heading, old.entities);
      INSERT INTO chunks_fts(rowid, content, heading, entities) VALUES (new.id, new.content, new.heading, new.entities);
    END;`);
  } catch (_) {}
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
  if (filePath.startsWith('data/fireflies') || filePath.startsWith('data/gauntlet')) return 0.6;
  if (filePath.startsWith('data/')) return 0.8;
  return 1.0;
}

function insertChunks(db, filePath, mtimeMs, chunks, createdAt) {
  const now = new Date().toISOString();
  const weight = getFileWeight(filePath);
  const insert = db.prepare(`
    INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    deleteFileChunks(db, filePath);
    for (const c of chunks) {
      const chunkType = c.chunkType || 'raw';
      const confidence = c.confidence != null ? c.confidence : 1.0;
      insert.run(filePath, c.heading || null, c.content, c.lineStart, c.lineEnd, JSON.stringify(c.entities), chunkType, confidence, createdAt || now, now, weight);
    }
    db.prepare(`INSERT OR REPLACE INTO files (file_path, mtime_ms, chunk_count, indexed_at) VALUES (?, ?, ?, ?)`)
      .run(filePath, mtimeMs, chunks.length, now);
  });
  tx();
}

function search(db, query, { limit = 10, sinceDate = null, untilDate = null, chunkType = null, minConfidence = null, includeStale = false, skipTracking = false } = {}) {
  let sql = `
    SELECT c.*, chunks_fts.rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
  `;
  const params = [query];
  const conditions = ['chunks_fts MATCH ?'];
  if (!includeStale) {
    conditions.push('c.stale = 0');
  }
  if (sinceDate) {
    conditions.push('c.created_at >= ?');
    params.push(sinceDate);
  }
  if (untilDate) {
    conditions.push('c.created_at < ?');
    params.push(untilDate);
  }
  if (chunkType) {
    conditions.push('c.chunk_type = ?');
    params.push(chunkType);
  }
  if (minConfidence != null) {
    conditions.push('c.confidence >= ?');
    params.push(minConfidence);
  }
  sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY chunks_fts.rank LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  if (rows.length > 0 && !skipTracking) {
    const trackAccess = db.prepare('UPDATE chunks SET access_count = access_count + 1, last_accessed = ? WHERE id = ?');
    const now = new Date().toISOString();
    const tx = db.transaction(() => { for (const row of rows) trackAccess.run(now, row.id); });
    tx();
  }
  return rows;
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

function getAllFilePaths(db) {
  return db.prepare('SELECT file_path FROM files').all().map(r => r.file_path);
}

function getChunksByFile(db, filePath) {
  return db.prepare(
    'SELECT * FROM chunks WHERE file_path LIKE ? ORDER BY line_start ASC'
  ).all(`%${filePath}%`);
}

module.exports = { SCHEMA, openDb, getFileMeta, deleteFileChunks, insertChunks, search, getAdjacentChunks, getStats, getAllFilePaths, getChunksByFile };
