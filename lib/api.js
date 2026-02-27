'use strict';

const path = require('path');
const fs = require('fs');
const { openDb, getStats, getFileMeta, insertChunks } = require('./store');
const { recall } = require('./recall');
const { remember: rememberFn } = require('./remember');
const { indexWorkspace, chunkMarkdown } = require('./indexer');
const { runReflectCycle, restoreChunk } = require('./reflect');
const { loadConfig, resolveIncludes, resolveFileType } = require('./config');
const { extractFacts } = require('./retain');
const { getRelevantContext } = require('./context');

function create({ workspace } = {}) {
  const ws = path.resolve(workspace || process.cwd());
  const db = openDb(ws);
  const config = loadConfig(ws);

  function indexSingleFile(filePath) {
    const stat = fs.statSync(filePath);
    const mtimeMs = Math.floor(stat.mtimeMs);
    const relPath = path.relative(ws, filePath);
    const meta = getFileMeta(db, relPath);
    if (meta && meta.mtime_ms === mtimeMs) return { skipped: true };

    const text = fs.readFileSync(filePath, 'utf-8');
    const chunks = chunkMarkdown(text);
    const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
    const createdAt = dateMatch ? dateMatch[1] + 'T00:00:00.000Z' : null;

    const fileDefault = resolveFileType(relPath, config.fileTypeDefaults || {});
    if (fileDefault) {
      for (const chunk of chunks) {
        chunk.chunkType = fileDefault.type;
        chunk.confidence = fileDefault.confidence;
      }
    }

    const facts = extractFacts(text, relPath);
    if (facts.length > 0) {
      for (const chunk of chunks) {
        let bestFact = null;
        for (const f of facts) {
          if (f.lineStart >= chunk.lineStart && f.lineStart <= chunk.lineEnd) {
            if (!bestFact || f.confidence > bestFact.confidence) bestFact = f;
          }
        }
        if (bestFact) {
          chunk.chunkType = bestFact.type;
          chunk.confidence = bestFact.confidence;
        }
      }
    }

    insertChunks(db, relPath, mtimeMs, chunks, createdAt);
    return { skipped: false };
  }

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
      try { indexSingleFile(result.filePath); } catch (_) {}
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

    close() {
      try { db.close(); } catch (_) {}
    },
  };
}

module.exports = { create };
