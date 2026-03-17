'use strict';

const path = require('path');
const { openDb, getStats, getAllFilePaths, deleteFileChunks } = require('./store');
const { recall } = require('./recall');
const { remember: rememberFn } = require('./remember');
const { indexWorkspace, indexSingleFile: _indexSingleFile, classifyChunk } = require('./indexer');
const { runReflectCycle, restoreChunk, setLastReflectTime } = require('./reflect');
const { loadConfig, resolveIncludes, isExcludedFromRecall } = require('./config');
const { getRelevantContext } = require('./context');
const { buildEntityIndex, getEntity, listEntities, getRelatedEntities, generateEntityPage, generateEntityPages } = require('./entities');
const embeddings = require('./embeddings');
const { stripQuery } = require('./query-strip');

function create({ workspace } = {}) {
  const ws = path.resolve(workspace || process.cwd());
  const db = openDb(ws);
  const config = loadConfig(ws);
  const fileTypeDefaults = config.fileTypeDefaults || {};

  return {
    async query(text, opts = {}) {
      let queryEmbedding = null;
      try {
        if (embeddings.isAvailable()) {
          queryEmbedding = await embeddings.embed(text);
        }
      } catch (err) { console.debug('[sme:api] query embedding failed:', err.message); }
      return recall(db, text, {
        limit: opts.limit,
        since: opts.since,
        until: opts.until,
        context: opts.context,
        workspace: ws,
        chunkType: opts.type || opts.chunkType || null,
        minConfidence: opts.minConfidence != null ? opts.minConfidence : null,
        includeStale: opts.includeStale || false,
        excludeFromRecall: opts.excludeFromRecall ?? config.excludeFromRecall ?? [],
        recallProfile: opts.recallProfile ?? config.recallProfile ?? null,
        queryEmbedding,
      });
    },

    async remember(content, opts = {}) {
      const result = rememberFn(ws, content, opts);
      const excludePatterns = [...(config.excludeFromRecall || []), ...(config.alwaysExclude || [])];
      try { _indexSingleFile(db, ws, result.filePath, fileTypeDefaults, excludePatterns); } catch (err) { console.debug('[sme:api] post-remember index failed:', err.message); }
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
      } catch (err) { console.debug('[sme:api] post-remember embedding failed:', err.message); }
      return result;
    },

    async index(opts = {}) {
      const extras = resolveIncludes(ws, config);
      const include = extras.map(p => path.relative(ws, p));
      const fileTypeDefaults = config.fileTypeDefaults || {};
      const excludePatterns = [...(config.excludeFromRecall || []), ...(config.alwaysExclude || [])];
      const result = indexWorkspace(db, ws, { force: opts.force || false, include, fileTypeDefaults, excludePatterns });
      // Embed new chunks after indexing
      if (embeddings.isAvailable()) {
        try {
          result.embedding = await embeddings.embedAll(db);
        } catch (err) { console.debug('[sme:api] post-index embedding failed:', err.message); }
      }
      return result;
    },

    async context(message, opts = {}) {
      const stripped = stripQuery(message);
      const cleanMessage = stripped.length >= 3 ? stripped : message;
      let queryEmbedding = null;
      try {
        queryEmbedding = await embeddings.embed(cleanMessage);
      } catch (err) { console.debug('[sme:api] context embedding failed:', err.message); }
      return getRelevantContext(db, cleanMessage, {
        ...opts,
        workspace: ws,
        queryEmbedding,
        excludeFromRecall: opts.excludeFromRecall ?? config.excludeFromRecall ?? [],
        alwaysExclude: opts.alwaysExclude ?? config.alwaysExclude ?? [],
        fileWeights: opts.fileWeights ?? config.fileWeights ?? null,
        recallProfile: opts.recallProfile ?? config.recallProfile ?? null,
      });
    },

    async reflect(opts = {}) {
      const result = runReflectCycle(db, { ...opts, config, workspace: ws });
      if (!opts.dryRun) { try { setLastReflectTime(ws); } catch (err) { console.debug('[sme:api] setLastReflectTime failed:', err.message); } }
      // Rotate recall log during maintenance
      try {
        const { rotateLog } = require('./recall-logger');
        result.logRotation = rotateLog(ws);
      } catch (err) { console.debug('[sme:api] log rotation failed:', err.message); }
      // Catch-up embedding during maintenance
      if (embeddings.isAvailable()) {
        try {
          result.embedding = await embeddings.embedAll(db);
        } catch (err) { console.debug('[sme:api] post-reflect embedding failed:', err.message); }
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

    entityPage(name) {
      return generateEntityPage(db, name);
    },

    entityPages(opts = {}) {
      const outputDir = path.join(ws, '.memory', 'entities');
      return generateEntityPages(db, outputDir, opts);
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

    reclassify({ dryRun = false } = {}) {
      const rows = db.prepare("SELECT id, content, heading, chunk_type FROM chunks WHERE chunk_type = 'raw'").all();
      const breakdown = {};
      const updates = [];
      for (const row of rows) {
        const newType = classifyChunk(row.content);
        if (newType) {
          updates.push({ id: row.id, type: newType });
          breakdown[newType] = (breakdown[newType] || 0) + 1;
        }
      }
      if (!dryRun && updates.length > 0) {
        const stmt = db.prepare('UPDATE chunks SET chunk_type = ? WHERE id = ?');
        const tx = db.transaction(() => { for (const u of updates) stmt.run(u.type, u.id); });
        tx();
      }
      return { reclassified: updates.length, breakdown };
    },

    purge({ patterns } = {}) {
      const resolvedPatterns = patterns || [...(config.excludeFromRecall || []), ...(config.alwaysExclude || [])];
      if (resolvedPatterns.length === 0) return { removed: 0, patterns: [] };
      const allPaths = getAllFilePaths(db);
      let removed = 0;
      for (const filePath of allPaths) {
        if (isExcludedFromRecall(filePath, resolvedPatterns)) {
          deleteFileChunks(db, filePath);
          removed++;
        }
      }
      return { removed, patterns: resolvedPatterns };
    },

    close() {
      try { db.close(); } catch (_) { /* expected: db may already be closed */ }
    },
  };
}

module.exports = { create };
