'use strict';

const path = require('path');
const { openDb, getStats } = require('./store');
const { recall } = require('./recall');
const { remember: rememberFn } = require('./remember');
const { indexWorkspace, indexSingleFile: _indexSingleFile } = require('./indexer');
const { runReflectCycle, restoreChunk } = require('./reflect');
const { loadConfig, resolveIncludes } = require('./config');
const { getRelevantContext } = require('./context');
const { buildEntityIndex, getEntity, listEntities, getRelatedEntities } = require('./entities');
const embeddings = require('./embeddings');
const { stripQuery } = require('./query-strip');

function create({ workspace } = {}) {
  const ws = path.resolve(workspace || process.cwd());
  const db = openDb(ws);
  const config = loadConfig(ws);
  const fileTypeDefaults = config.fileTypeDefaults || {};

  return {
    query(text, opts = {}) {
      return recall(db, text, {
        limit: opts.limit,
        since: opts.since,
        context: opts.context,
        workspace: ws,
        chunkType: opts.type || opts.chunkType || null,
        minConfidence: opts.minConfidence != null ? opts.minConfidence : null,
        includeStale: opts.includeStale || false,
        excludeFromRecall: opts.excludeFromRecall ?? config.excludeFromRecall ?? [],
      });
    },

    async remember(content, opts = {}) {
      const result = rememberFn(ws, content, opts);
      try { _indexSingleFile(db, ws, result.filePath, fileTypeDefaults); } catch (_) {}
      // Embed newly indexed chunks from this file
      try {
        if (embeddings.isAvailable()) {
          embeddings.ensureEmbeddingColumn(db);
          const rows = db.prepare('SELECT id, content FROM chunks WHERE file_path = ? AND embedding IS NULL').all(result.filePath);
          for (const row of rows) {
            const vec = await embeddings.embed(row.content);
            if (vec) db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(Buffer.from(vec.buffer), row.id);
          }
        }
      } catch (_) {}
      return result;
    },

    async index(opts = {}) {
      const extras = resolveIncludes(ws, config);
      const include = extras.map(p => path.relative(ws, p));
      const fileTypeDefaults = config.fileTypeDefaults || {};
      const result = indexWorkspace(db, ws, { force: opts.force || false, include, fileTypeDefaults });
      // Embed new chunks after indexing
      if (embeddings.isAvailable()) {
        try {
          result.embedding = await embeddings.embedAll(db);
        } catch (_) {}
      }
      return result;
    },

    async context(message, opts = {}) {
      const stripped = stripQuery(message);
      const cleanMessage = stripped.length >= 3 ? stripped : message;
      let queryEmbedding = null;
      try {
        queryEmbedding = await embeddings.embed(cleanMessage);
      } catch (_) {}
      return getRelevantContext(db, cleanMessage, {
        ...opts,
        workspace: ws,
        queryEmbedding,
        excludeFromRecall: opts.excludeFromRecall ?? config.excludeFromRecall ?? [],
        alwaysExclude: opts.alwaysExclude ?? config.alwaysExclude ?? [],
        fileWeights: opts.fileWeights ?? config.fileWeights ?? null,
      });
    },

    async reflect(opts = {}) {
      const result = runReflectCycle(db, { ...opts, config });
      // Rotate recall log during maintenance
      try {
        const { rotateLog } = require('./recall-logger');
        result.logRotation = rotateLog(ws);
      } catch (_) {}
      // Catch-up embedding during maintenance
      if (embeddings.isAvailable()) {
        try {
          result.embedding = await embeddings.embedAll(db);
        } catch (_) {}
      }
      return result;
    },

    status() {
      return getStats(db);
    },

    restore(chunkId) {
      return restoreChunk(db, chunkId);
    },

    entities(name) {
      if (name) return getEntity(db, name);
      return listEntities(db);
    },

    relatedEntities(name) {
      return getRelatedEntities(db, name);
    },

    buildEntities(opts = {}) {
      return buildEntityIndex(db, opts);
    },

    ingest(sourcePath, opts = {}) {
      const { syncFile } = require('./ingest');
      return syncFile(db, ws, sourcePath, { fileTypeDefaults, ...opts });
    },

    parseTranscript(text, opts = {}) {
      const { parseTranscript } = require('./ingest');
      return parseTranscript(text, opts);
    },

    parseCsv(text, opts = {}) {
      const { parseCsv } = require('./ingest');
      return parseCsv(text, opts);
    },

    recallStats(opts = {}) {
      const { summarizeLog } = require('./recall-logger');
      return summarizeLog(ws, opts);
    },

    async embedAll(opts = {}) {
      if (!embeddings.isAvailable()) {
        return { embedded: 0, skipped: 0, total: 0, error: 'Embedding dependency not available' };
      }
      return embeddings.embedAll(db, opts);
    },

    embeddingStatus() {
      return embeddings.embeddingStatus(db);
    },

    async warmup() {
      return embeddings.warmup();
    },

    close() {
      try { db.close(); } catch (_) {}
    },
  };
}

module.exports = { create };
