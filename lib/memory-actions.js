'use strict';

/**
 * Memory Actions (F4) — first-class mutation operations on stored chunks.
 *
 * Four actions:
 *   update   — rewrite content in-place, preserving id + created_at
 *   replace  — archive the old chunk (confidence→0, superseded_by set) and
 *              insert a new chunk with the new content, fresh id
 *   forget   — soft-delete: set confidence=0 and archived_at (excluded from
 *              recall via the confidence floor, but row still exists)
 *   protect  — set protected=1; reflect decay/prune skip the chunk
 *
 * Targets resolve two ways:
 *   - numeric id  → direct SELECT WHERE id = ?
 *   - query text  → run a recall, require top result score >= MIN_CONFIDENCE
 *                   and NOT ambiguous (top 2 within AMBIGUITY_DELTA → review queue)
 */

const { recall } = require('./recall');

class AmbiguousTargetError extends Error {
  constructor(candidates) {
    super(`Target query matches multiple chunks (within ambiguity delta). Review the candidates and re-run with an explicit id.`);
    this.name = 'AmbiguousTargetError';
    this.candidates = candidates;
  }
}

class TargetNotFoundError extends Error {
  constructor(target) {
    super(`No chunk found for target: ${target}`);
    this.name = 'TargetNotFoundError';
    this.target = target;
  }
}

const MIN_CONFIDENCE = 0.7;  // top result must clear this score to be a valid target
const AMBIGUITY_DELTA = 0.08;  // if top 2 are within this, refuse the action

/**
 * Resolve a target to a concrete chunk row.
 * @returns {object} chunk row from db
 */
function resolveTarget(db, target, { workspace = null } = {}) {
  if (target == null) throw new TargetNotFoundError(target);

  // Numeric id (string or number)
  const asNum = typeof target === 'number' ? target : /^\d+$/.test(String(target)) ? parseInt(target, 10) : null;
  if (asNum != null) {
    const row = db.prepare('SELECT * FROM chunks WHERE id = ?').get(asNum);
    if (!row) throw new TargetNotFoundError(target);
    return row;
  }

  // Query-based resolution — run a recall, inspect top candidates
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new TargetNotFoundError(target);
  }
  const results = recall(db, target, {
    limit: 5,
    workspace,
    includeStale: true,
    orchestrator: false,  // deterministic: don't let strategy classification shift the target
    recordStats: false,   // don't pollute recall_count from mutation-path lookups
  });
  if (!results || results.length === 0) throw new TargetNotFoundError(target);

  const top = results[0];
  // Top score must clear the minimum confidence to count as a real match
  if ((top.finalScore || top.score || 0) < MIN_CONFIDENCE) {
    throw new TargetNotFoundError(target);
  }
  // Ambiguity check — top 2 within delta means we can't safely pick one
  if (results.length >= 2) {
    const delta = Math.abs((top.finalScore || top.score) - (results[1].finalScore || results[1].score));
    if (delta < AMBIGUITY_DELTA) {
      throw new AmbiguousTargetError(results.slice(0, 3).map(r => ({
        id: r.id,
        content: r.content,
        filePath: r.filePath,
        score: r.finalScore || r.score,
      })));
    }
  }

  // Fetch the full row (recall() returns a shaped object, not raw row)
  const row = db.prepare('SELECT * FROM chunks WHERE id = ?').get(top.id);
  if (!row) throw new TargetNotFoundError(target);
  return row;
}

/**
 * Execute a mutation action on a chunk.
 *
 * @param {Database} db
 * @param {object} params
 * @param {string} params.action — 'update' | 'replace' | 'forget' | 'protect'
 * @param {number|string} params.target — chunk id or query string
 * @param {string} [params.content] — required for update/replace
 * @param {string} [params.workspace]
 * @returns {object} result describing what happened
 */
function executeAction(db, { action, target, content = null, workspace = null } = {}) {
  if (!action) throw new Error('action is required');
  const chunk = resolveTarget(db, target, { workspace });
  const nowISO = new Date().toISOString();

  switch (action) {
    case 'update': {
      if (!content || typeof content !== 'string') throw new Error('update requires content');
      db.prepare('UPDATE chunks SET content = ?, indexed_at = ? WHERE id = ?')
        .run(content, nowISO, chunk.id);
      return { action, id: chunk.id, newContent: content };
    }

    case 'replace': {
      if (!content || typeof content !== 'string') throw new Error('replace requires content');
      // Insert new chunk first so we can reference its id
      const insert = db.prepare(`
        INSERT INTO chunks (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, memory_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let newId = null;
      const tx = db.transaction(() => {
        const info = insert.run(
          chunk.file_path, chunk.heading, content,
          chunk.line_start, chunk.line_end, chunk.entities, chunk.chunk_type,
          1.0, nowISO, nowISO, chunk.file_weight || 1.0, chunk.memory_tier || 'working_reference'
        );
        newId = info.lastInsertRowid;
        db.prepare('UPDATE chunks SET confidence = 0, superseded_by = ?, archived_at = ? WHERE id = ?')
          .run(newId, nowISO, chunk.id);
      });
      tx();
      return { action, oldId: chunk.id, newId, newContent: content };
    }

    case 'forget': {
      db.prepare('UPDATE chunks SET confidence = 0, archived_at = ? WHERE id = ?')
        .run(nowISO, chunk.id);
      return { action, id: chunk.id };
    }

    case 'protect': {
      db.prepare('UPDATE chunks SET protected = 1 WHERE id = ?').run(chunk.id);
      return { action, id: chunk.id, protected: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

module.exports = {
  executeAction,
  resolveTarget,
  AmbiguousTargetError,
  TargetNotFoundError,
  MIN_CONFIDENCE,
  AMBIGUITY_DELTA,
};
