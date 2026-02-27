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
      });
    },

    remember(content, opts = {}) {
      const result = rememberFn(ws, content, opts);
      try { _indexSingleFile(db, ws, result.filePath, fileTypeDefaults); } catch (_) {}
      return result;
    },

    index(opts = {}) {
      const extras = resolveIncludes(ws, config);
      const include = extras.map(p => path.relative(ws, p));
      const fileTypeDefaults = config.fileTypeDefaults || {};
      return indexWorkspace(db, ws, { force: opts.force || false, include, fileTypeDefaults });
    },

    context(message, opts = {}) {
      return getRelevantContext(db, message, { ...opts, workspace: ws });
    },

    reflect(opts = {}) {
      return runReflectCycle(db, opts);
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

    close() {
      try { db.close(); } catch (_) {}
    },
  };
}

module.exports = { create };
