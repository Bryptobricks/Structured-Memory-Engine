/**
 * v3 Reflect — confidence decay, reinforcement, staleness, contradiction detection, pruning, restore.
 * All rule-based, zero LLM calls.
 */

const NEGATION_PATTERN = /\b(not|no longer|stopped|quit|switched from|dropped|removed|cancelled|never|don't|doesn't|didn't|won't|can't)\b/i;

const GENERIC_HEADINGS = new Set([
  'overview', 'setup', 'installation', 'usage', 'dependencies', 'requirements',
  'getting started', 'introduction', 'summary', 'notes', 'context', 'references',
  'links', 'resources', 'todo', 'changelog', 'configuration', 'config',
  'what was done', 'what i learned', 'open questions', 'files changed',
  'decisions', 'status', 'progress', 'issues', 'tools', 'preferences',
  'people', 'lessons', 'health', 'projects', 'identity', 'index',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor',
  'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own',
  'same', 'than', 'too', 'very', 'just', 'because', 'if', 'when', 'while',
  'that', 'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
  'their', 'what', 'which', 'who', 'whom', 'how', 'where', 'why',
]);

const DECAY_RATES = {
  confirmed: 0,
  decision: 0.3,
  preference: 0.3,
  fact: 0.8,
  opinion: 0.8,
  inferred: 1.0,
  raw: 1.5,
  action_item: 1.2,
  outdated: 2.0,
};
const DEFAULT_DECAY_RATE = 1.0;

function daysBetween(dateStr, now) {
  if (!dateStr) return 0;
  const d = new Date(dateStr).getTime();
  return Math.max(0, (now - d) / (1000 * 60 * 60 * 24));
}

function decayConfidence(db, { dryRun = false, config = null } = {}) {
  const now = Date.now();
  const halfLife = (config && config.reflect && config.reflect.halfLifeDays) || 120;
  const rateMultiplier = (config && config.reflect && config.reflect.decayRate) || 1.0;
  const rows = db.prepare('SELECT id, heading, chunk_type, confidence, last_accessed, created_at FROM chunks WHERE confidence > 0 AND chunk_type != ?').all('confirmed');
  const details = [];
  const updates = [];

  for (const row of rows) {
    const rate = DECAY_RATES[row.chunk_type] != null ? DECAY_RATES[row.chunk_type] : DEFAULT_DECAY_RATE;
    if (rate === 0) continue;
    const ref = row.last_accessed || row.created_at;
    const daysSince = daysBetween(ref, now);
    const decayAmount = (daysSince / halfLife) * rate * rateMultiplier * 0.5;
    if (decayAmount <= 0) continue;
    const newConf = Math.max(0, row.confidence - decayAmount);
    if (newConf !== row.confidence) {
      details.push({ id: row.id, heading: row.heading, oldConf: row.confidence, newConf: Math.round(newConf * 1000) / 1000, daysSinceAccess: Math.round(daysSince) });
      updates.push({ id: row.id, newConf: Math.round(newConf * 1000) / 1000 });
    }
  }

  if (!dryRun && updates.length > 0) {
    const stmt = db.prepare('UPDATE chunks SET confidence = ? WHERE id = ?');
    const tx = db.transaction(() => { for (const u of updates) stmt.run(u.newConf, u.id); });
    tx();
  }

  return { decayed: updates.length, details };
}

function reinforceConfidence(db, { dryRun = false } = {}) {
  const rows = db.prepare('SELECT id, heading, confidence, access_count FROM chunks WHERE access_count > 0').all();
  const details = [];
  const updates = [];

  for (const row of rows) {
    const accessFloor = Math.min(0.5, row.access_count * 0.02);
    const newConf = Math.max(row.confidence, accessFloor);
    if (newConf !== row.confidence) {
      details.push({ id: row.id, heading: row.heading, oldConf: row.confidence, newConf: Math.round(newConf * 1000) / 1000, accessCount: row.access_count });
      updates.push({ id: row.id, newConf: Math.round(newConf * 1000) / 1000 });
    }
  }

  if (!dryRun && updates.length > 0) {
    const stmt = db.prepare('UPDATE chunks SET confidence = ? WHERE id = ?');
    const tx = db.transaction(() => { for (const u of updates) stmt.run(u.newConf, u.id); });
    tx();
  }

  return { reinforced: updates.length, details };
}

function markStale(db, { dryRun = false } = {}) {
  const now = Date.now();
  const rows = db.prepare('SELECT id, heading, confidence, created_at FROM chunks WHERE stale = 0').all();
  const details = [];
  const updates = [];

  for (const row of rows) {
    const daysOld = daysBetween(row.created_at, now);
    const shouldStale = (row.confidence < 0.3 && daysOld > 90) || (row.confidence < 0.1 && daysOld > 30);
    if (shouldStale) {
      details.push({ id: row.id, heading: row.heading, confidence: row.confidence, daysOld: Math.round(daysOld) });
      updates.push(row.id);
    }
  }

  if (!dryRun && updates.length > 0) {
    const stmt = db.prepare('UPDATE chunks SET stale = 1 WHERE id = ?');
    const tx = db.transaction(() => { for (const id of updates) stmt.run(id); });
    tx();
  }

  return { marked: updates.length, details };
}

function extractTerms(text) {
  if (!text) return [];
  return text.toLowerCase().split(/\W+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function extractDateFromPath(filePath) {
  const m = filePath && filePath.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function negationNearSharedTerm(content, sharedTerms, windowSize) {
  if (!content || !sharedTerms || sharedTerms.length === 0) return false;
  const words = content.toLowerCase().split(/\W+/).filter(Boolean);
  const sharedSet = new Set(sharedTerms.map(t => t.toLowerCase()));
  const negWords = new Set(['not', 'no', 'never', 'stopped', 'quit', 'dropped', 'removed', 'cancelled']);
  for (let i = 0; i < words.length; i++) {
    if (negWords.has(words[i])) {
      const start = Math.max(0, i - windowSize);
      const end = Math.min(words.length, i + windowSize + 1);
      for (let j = start; j < end; j++) {
        if (j !== i && sharedSet.has(words[j])) return true;
      }
    }
  }
  return false;
}

function detectContradictions(db, { dryRun = false, config = null } = {}) {
  const rows = db.prepare(`SELECT id, heading, content, file_path, created_at FROM chunks WHERE heading IS NOT NULL AND length(heading) > 0`).all();
  const existing = new Set();
  const existingRows = db.prepare('SELECT chunk_id_old, chunk_id_new FROM contradictions').all();
  for (const e of existingRows) existing.add(`${e.chunk_id_old}:${e.chunk_id_new}`);

  // Group by heading, skip generic headings
  const groups = {};
  for (const row of rows) {
    const key = row.heading.toLowerCase().trim();
    if (GENERIC_HEADINGS.has(key)) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  const details = [];
  const inserts = [];
  const now = new Date().toISOString();

  const MAX_GROUP_SIZE = 50; // Cap O(n²) comparisons per heading group
  const termsCache = new Map(); // Memoize extractTerms per chunk id

  function getTerms(chunk) {
    if (termsCache.has(chunk.id)) return termsCache.get(chunk.id);
    const t = extractTerms(chunk.content);
    termsCache.set(chunk.id, t);
    return t;
  }

  for (const key of Object.keys(groups)) {
    const group = groups[key];
    if (group.length < 2) continue;
    // Skip recurring sections — headings that appear across 3+ files are templates, not contradictions
    const uniqueFiles = new Set(group.map(r => r.file_path));
    if (uniqueFiles.size >= 3) continue;
    // Cap large groups to prevent O(n²) blowup
    if (group.length > MAX_GROUP_SIZE) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a.file_path === b.file_path) continue;
        const idOld = Math.min(a.id, b.id);
        const idNew = Math.max(a.id, b.id);
        if (existing.has(`${idOld}:${idNew}`)) continue;

        const termsA = getTerms(a);
        const termsB = new Set(getTerms(b));
        const shared = termsA.filter(t => termsB.has(t));
        const minShared = (config && config.reflect && config.reflect.contradictionMinSharedTerms != null) ? config.reflect.contradictionMinSharedTerms : 3;
        if (shared.length < minShared) continue;

        // Divergence check: if shared terms are > 80% of the smaller set, it's a near-duplicate not a contradiction
        const smallerSize = Math.min(termsA.length, termsB.size);
        if (smallerSize > 0 && shared.length / smallerSize > 0.8) continue;

        const hasNegation = NEGATION_PATTERN.test(a.content) || NEGATION_PATTERN.test(b.content);
        if (!hasNegation) continue;

        // Temporal progression: if negation only appears in the newer chunk and both are dated, it's an update
        if (config && config.reflect && config.reflect.contradictionTemporalAwareness) {
          const dateA = extractDateFromPath(a.file_path);
          const dateB = extractDateFromPath(b.file_path);
          if (dateA && dateB) {
            const older = dateA <= dateB ? a : b;
            const newer = dateA <= dateB ? b : a;
            const olderHasNeg = NEGATION_PATTERN.test(older.content);
            const newerHasNeg = NEGATION_PATTERN.test(newer.content);
            if (newerHasNeg && !olderHasNeg) continue;
          }
        }

        // Negation proximity: negation must be near a shared term
        if (config && config.reflect && config.reflect.contradictionRequireProximity) {
          const windowSize = 8;
          const uniqueShared = [...new Set(shared)];
          const aNear = negationNearSharedTerm(a.content, uniqueShared, windowSize);
          const bNear = negationNearSharedTerm(b.content, uniqueShared, windowSize);
          if (!aNear && !bNear) continue;
        }

        const reason = `Shared terms: ${[...new Set(shared)].slice(0, 5).join(', ')}; negation detected`;
        details.push({ idOld, idNew, headingOld: a.heading, headingNew: b.heading, reason });
        inserts.push({ idOld, idNew, reason, now });
        existing.add(`${idOld}:${idNew}`);
      }
    }
  }

  if (!dryRun && inserts.length > 0) {
    const stmt = db.prepare('INSERT INTO contradictions (chunk_id_old, chunk_id_new, reason, created_at) VALUES (?, ?, ?, ?)');
    const tx = db.transaction(() => { for (const ins of inserts) stmt.run(ins.idOld, ins.idNew, ins.reason, ins.now); });
    tx();
  }

  const totalInDB = db.prepare('SELECT COUNT(*) as n FROM contradictions').get().n + (dryRun ? inserts.length : 0);
  return { found: dryRun ? totalInDB : db.prepare('SELECT COUNT(*) as n FROM contradictions').get().n, newFlags: inserts.length, details };
}

function pruneStale(db, { dryRun = false } = {}) {
  const now = Date.now();
  const nowISO = new Date().toISOString();
  const rows = db.prepare('SELECT * FROM chunks WHERE stale = 1').all();
  const details = [];
  const toArchive = [];

  for (const row of rows) {
    const daysOld = daysBetween(row.created_at, now);
    let reason = null;
    if (row.confidence < 0.1 && daysOld > 180) {
      reason = `stale + confidence ${row.confidence} < 0.1, ${Math.round(daysOld)}d old`;
    } else if (row.access_count === 0 && row.confidence < 0.05) {
      reason = `never accessed + confidence ${row.confidence} < 0.05`;
    }
    if (reason) {
      details.push({ id: row.id, heading: row.heading, confidence: row.confidence, daysOld: Math.round(daysOld), reason });
      toArchive.push({ row, reason });
    }
  }

  if (!dryRun && toArchive.length > 0) {
    const insertArchive = db.prepare(`INSERT INTO archived_chunks
      (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, archived_at, archive_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const deleteChunk = db.prepare('DELETE FROM chunks WHERE id = ?');
    const tx = db.transaction(() => {
      for (const { row, reason } of toArchive) {
        insertArchive.run(row.file_path, row.heading, row.content, row.line_start, row.line_end, row.entities, row.chunk_type, row.confidence, row.created_at, row.indexed_at, row.file_weight, row.access_count, row.last_accessed, row.stale, nowISO, reason);
        deleteChunk.run(row.id);
      }
    });
    tx();
  }

  return { archived: toArchive.length, details };
}

function restoreChunk(db, chunkId) {
  const row = db.prepare('SELECT * FROM archived_chunks WHERE id = ?').get(chunkId);
  if (!row) return { restored: false, error: `Archived chunk ${chunkId} not found` };

  const result = db.prepare(`INSERT INTO chunks
    (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
    row.file_path, row.heading, row.content, row.line_start, row.line_end, row.entities, row.chunk_type, row.confidence, row.created_at, row.indexed_at, row.file_weight, row.access_count, row.last_accessed
  );
  db.prepare('DELETE FROM archived_chunks WHERE id = ?').run(chunkId);
  return { restored: true, newId: result.lastInsertRowid };
}

const REVIEW_VERSION = 'v7.4-001';

/**
 * Value Assessment phase — compute value scores, enforce floors/accelerated decay, archive junk.
 */
function valueAssessment(db, { dryRun = false, mode = 'apply' } = {}) {
  const { assessChunkValue } = require('./value-scoring');
  const isApply = mode === 'apply' && !dryRun;
  const now = new Date().toISOString();

  const rows = db.prepare('SELECT id, content, chunk_type, confidence, file_path, created_at FROM chunks WHERE stale = 0').all();
  const result = { total: rows.length, byLabel: { core: 0, situational: 0, noise: 0, junk: 0 }, archived: 0, decayBoosted: 0, confidenceFloored: 0 };

  const updateValue = db.prepare('UPDATE chunks SET value_score = ?, value_label = ? WHERE id = ?');
  const insertLedger = db.prepare('INSERT INTO audit_ledger (chunk_id, action, value_score, value_label, reason_codes, reviewed_at, review_version) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertArchive = db.prepare(`INSERT INTO archived_chunks
    (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, archived_at, archive_reason)
    SELECT file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, ?, ?
    FROM chunks WHERE id = ?`);
  const deleteChunk = db.prepare('DELETE FROM chunks WHERE id = ?');
  const updateConfidence = db.prepare('UPDATE chunks SET confidence = ? WHERE id = ?');

  const tx = db.transaction(() => {
    for (const row of rows) {
      const { valueScore, valueLabel } = assessChunkValue(row);
      result.byLabel[valueLabel] = (result.byLabel[valueLabel] || 0) + 1;

      // Always write value_score/label (even in shadow mode, for visibility)
      updateValue.run(valueScore, valueLabel, row.id);

      let action = 'keep';
      const reasons = [];

      if (valueLabel === 'junk') {
        action = 'archive';
        reasons.push('value_label=junk');
        if (isApply) {
          insertArchive.run(now, `value_assessment: junk (score=${valueScore.toFixed(3)})`, row.id);
          deleteChunk.run(row.id);
          result.archived++;
        }
      } else if (valueLabel === 'noise') {
        action = 'decay';
        reasons.push('value_label=noise, 2x decay');
        if (isApply) {
          const newConf = Math.max(0, row.confidence - 0.05);
          if (newConf !== row.confidence) {
            updateConfidence.run(newConf, row.id);
            result.decayBoosted++;
          }
        }
      } else if (valueLabel === 'core') {
        // Confidence floor for core memories
        if (row.confidence < 0.5) {
          action = 'keep';
          reasons.push('core: confidence floor 0.5');
          if (isApply) {
            updateConfidence.run(0.5, row.id);
            result.confidenceFloored++;
          }
        }
      }

      insertLedger.run(row.id, action, valueScore, valueLabel, JSON.stringify(reasons), now, REVIEW_VERSION);
    }
  });
  tx();

  return result;
}

/**
 * Retroactive Dedup Scan — find duplicates in pre-v7.3 data.
 */
function retroDedupScan(db, { dryRun = false, mode = 'apply', config = null } = {}) {
  const { findDuplicates } = require('./dedup');
  const isApply = mode === 'apply' && !dryRun;
  const now = new Date().toISOString();
  const dedupConfig = (config && config.dedup) || {};
  const autoMergeThreshold = dedupConfig.autoMergeThreshold || 0.92;
  const reviewThreshold = dedupConfig.reviewThreshold || 0.85;
  const typeThresholds = dedupConfig.typeThresholds || {};

  // Only scan chunks without existing audit_ledger entry for this version
  const audited = new Set();
  try {
    const auditedRows = db.prepare('SELECT DISTINCT chunk_id FROM audit_ledger WHERE review_version = ? AND action = ?').all(REVIEW_VERSION, 'merge_candidate');
    for (const r of auditedRows) audited.add(r.chunk_id);
  } catch (_) { /* table may not exist yet */ }

  const result = { scanned: 0, skipped: 0, autoMerged: 0, queuedForReview: 0 };

  // Group chunks by type, cap at 500 per type
  const types = db.prepare('SELECT DISTINCT chunk_type FROM chunks WHERE stale = 0').all().map(r => r.chunk_type);
  const insertReview = db.prepare('INSERT INTO dedup_reviews (new_chunk_id, existing_chunk_id, similarity, status, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertArchive = db.prepare(`INSERT INTO archived_chunks
    (file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, archived_at, archive_reason)
    SELECT file_path, heading, content, line_start, line_end, entities, chunk_type, confidence, created_at, indexed_at, file_weight, access_count, last_accessed, stale, ?, ?
    FROM chunks WHERE id = ?`);
  const deleteChunk = db.prepare('DELETE FROM chunks WHERE id = ?');

  const tx = db.transaction(() => {
    for (const type of types) {
      const chunks = db.prepare('SELECT id, content, chunk_type, value_score, created_at FROM chunks WHERE chunk_type = ? AND stale = 0 ORDER BY created_at ASC LIMIT 500').all(type);

      const autoMerge = typeThresholds[type] || autoMergeThreshold;
      const review = Math.min(autoMerge, typeThresholds[type] ? typeThresholds[type] - 0.04 : reviewThreshold);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (audited.has(chunk.id)) { result.skipped++; continue; }
        result.scanned++;

        // Compare against all other chunks of same type (excluding self)
        const others = chunks.filter((_, j) => j !== i);
        if (others.length === 0) continue;

        const dup = findDuplicates(others, chunk.content, { autoMergeThreshold: autoMerge, reviewThreshold: review });

        if (dup.action === 'skip') {
          result.autoMerged++;
          if (isApply) {
            insertArchive.run(now, `retro_dedup: merged with #${dup.existingId} (sim=${dup.similarity.toFixed(3)})`, chunk.id);
            deleteChunk.run(chunk.id);
          }
        } else if (dup.action === 'review') {
          result.queuedForReview++;
          if (isApply) {
            insertReview.run(chunk.id, dup.existingId, dup.similarity, 'pending', now);
          }
        }
      }
    }
  });
  tx();

  return result;
}

function runReflectCycle(db, { dryRun = false, config = null, mode = null } = {}) {
  // Resolve mode: support both legacy dryRun and new mode parameter
  const effectiveMode = mode || (dryRun ? 'shadow' : 'apply');
  const effectiveDryRun = effectiveMode === 'shadow';

  const decay = decayConfidence(db, { dryRun: effectiveDryRun, config });
  const reinforce = reinforceConfidence(db, { dryRun: effectiveDryRun });
  const stale = markStale(db, { dryRun: effectiveDryRun });
  const contradictions = detectContradictions(db, { dryRun: effectiveDryRun, config });

  // Value assessment phase (new in v7.4)
  let valueAssessmentResult = { total: 0, byLabel: {}, archived: 0, decayBoosted: 0, confidenceFloored: 0 };
  try {
    valueAssessmentResult = valueAssessment(db, { dryRun: effectiveDryRun, mode: effectiveMode });
  } catch (err) { console.debug('[sme:reflect] value assessment failed:', err.message); }

  const prune = pruneStale(db, { dryRun: effectiveDryRun });

  // Retroactive dedup scan (new in v7.4)
  let retroDedup = { scanned: 0, skipped: 0, autoMerged: 0, queuedForReview: 0 };
  try {
    retroDedup = retroDedupScan(db, { dryRun: effectiveDryRun, mode: effectiveMode, config });
  } catch (err) { console.debug('[sme:reflect] retro dedup failed:', err.message); }

  // Rebuild entity index as part of the reflect cycle
  let entityIndex = { entities: 0, chunks: 0 };
  try {
    const { buildEntityIndex } = require('./entities');
    entityIndex = buildEntityIndex(db, { dryRun: effectiveDryRun });
  } catch (err) { console.debug('[sme:reflect] entity index build failed:', err.message); }

  return { decay, reinforce, stale, contradictions, prune, entityIndex, valueAssessment: valueAssessmentResult, retroDedup, mode: effectiveMode };
}

function resolveContradiction(db, contradictionId, action) {
  const valid = ['keep-newer', 'keep-older', 'keep-both', 'dismiss'];
  if (!valid.includes(action)) {
    return { resolved: false, error: `Invalid action "${action}". Must be one of: ${valid.join(', ')}` };
  }

  const row = db.prepare('SELECT * FROM contradictions WHERE id = ?').get(contradictionId);
  if (!row) return { resolved: false, error: `Contradiction #${contradictionId} not found` };
  if (row.resolved) return { resolved: false, error: `Contradiction #${contradictionId} is already resolved` };

  const result = { resolved: true, action, chunkKept: null, chunkDowngraded: null };

  if (action === 'keep-newer') {
    db.prepare('UPDATE chunks SET chunk_type = ?, confidence = 0.3 WHERE id = ?').run('outdated', row.chunk_id_old);
    result.chunkKept = row.chunk_id_new;
    result.chunkDowngraded = row.chunk_id_old;
  } else if (action === 'keep-older') {
    db.prepare('UPDATE chunks SET chunk_type = ?, confidence = 0.3 WHERE id = ?').run('outdated', row.chunk_id_new);
    result.chunkKept = row.chunk_id_old;
    result.chunkDowngraded = row.chunk_id_new;
  }

  db.prepare('UPDATE contradictions SET resolved = 1 WHERE id = ?').run(contradictionId);
  return result;
}

function listContradictions(db, { resolved = false } = {}) {
  const rows = db.prepare(`
    SELECT c.id, c.reason, c.created_at, c.resolved,
           ca.content as content_old, ca.file_path as file_old, ca.heading as heading_old,
           cb.content as content_new, cb.file_path as file_new, cb.heading as heading_new
    FROM contradictions c
    JOIN chunks ca ON ca.id = c.chunk_id_old
    JOIN chunks cb ON cb.id = c.chunk_id_new
    WHERE c.resolved = ?
    ORDER BY c.created_at DESC
  `).all(resolved ? 1 : 0);

  return rows.map(r => ({
    id: r.id,
    reason: r.reason,
    createdAt: r.created_at,
    resolved: !!r.resolved,
    chunkOld: { content: r.content_old, filePath: r.file_old, heading: r.heading_old },
    chunkNew: { content: r.content_new, filePath: r.file_new, heading: r.heading_new },
  }));
}

/**
 * Get/set last reflect timestamp for time-gating.
 * Uses a simple file in .memory/_last_reflect.
 */
function getLastReflectTime(workspace) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(workspace, '.memory', '_last_reflect');
  try {
    const ts = fs.readFileSync(file, 'utf-8').trim();
    return new Date(ts).getTime();
  } catch (_) {
    return 0;
  }
}

function setLastReflectTime(workspace) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(workspace, '.memory', '_last_reflect');
  fs.writeFileSync(file, new Date().toISOString(), 'utf-8');
}

module.exports = { decayConfidence, reinforceConfidence, markStale, detectContradictions, pruneStale, restoreChunk, resolveContradiction, runReflectCycle, listContradictions, extractTerms, extractDateFromPath, negationNearSharedTerm, getLastReflectTime, setLastReflectTime, valueAssessment, retroDedupScan, REVIEW_VERSION };
