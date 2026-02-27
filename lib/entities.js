'use strict';

/**
 * Entity Index — flat lookup table with co-occurrence tracking.
 * Scans chunks for entities, builds a denormalized index for O(1) lookup.
 */

const ENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS entity_index (
  entity TEXT PRIMARY KEY,
  chunk_ids TEXT NOT NULL,
  co_entities TEXT NOT NULL DEFAULT '{}',
  mention_count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT
);
`;

function ensureEntityTable(db) {
  db.exec(ENTITY_SCHEMA);
}

/**
 * Build or rebuild the entity index from the chunks table.
 * Scans all non-stale chunks, extracts entities, tracks co-occurrences.
 */
function buildEntityIndex(db, { dryRun = false } = {}) {
  ensureEntityTable(db);

  const rows = db.prepare(
    'SELECT id, entities, created_at FROM chunks WHERE stale = 0 AND entities IS NOT NULL AND entities != \'[]\''
  ).all();

  // entity → { chunkIds: Set, coEntities: Map<string, number>, lastSeen: string }
  const index = new Map();

  for (const row of rows) {
    let entities;
    try { entities = JSON.parse(row.entities); } catch (_) { continue; }
    if (!Array.isArray(entities) || entities.length === 0) continue;

    const normalized = entities.map(e => e.toLowerCase().replace(/^@/, ''));

    for (const entity of normalized) {
      if (entity.length < 2) continue;
      if (!index.has(entity)) {
        index.set(entity, { chunkIds: new Set(), coEntities: new Map(), lastSeen: null });
      }
      const entry = index.get(entity);
      entry.chunkIds.add(row.id);
      if (!entry.lastSeen || row.created_at > entry.lastSeen) {
        entry.lastSeen = row.created_at;
      }

      // Track co-occurrences with other entities in the same chunk
      for (const other of normalized) {
        if (other !== entity && other.length >= 2) {
          entry.coEntities.set(other, (entry.coEntities.get(other) || 0) + 1);
        }
      }
    }
  }

  if (dryRun) {
    return { entities: index.size, chunks: rows.length };
  }

  // Write to DB
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO entity_index (entity, chunk_ids, co_entities, mention_count, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM entity_index').run();
    for (const [entity, data] of index) {
      const chunkIds = JSON.stringify([...data.chunkIds]);
      const coEntities = JSON.stringify(Object.fromEntries(data.coEntities));
      upsert.run(entity, chunkIds, coEntities, data.chunkIds.size, data.lastSeen);
    }
  });
  tx();

  return { entities: index.size, chunks: rows.length };
}

/**
 * Query an entity — returns its chunks and co-occurring entities.
 */
function getEntity(db, name) {
  ensureEntityTable(db);
  const normalized = name.toLowerCase().replace(/^@/, '');
  const row = db.prepare('SELECT * FROM entity_index WHERE entity = ?').get(normalized);
  if (!row) return null;

  return {
    entity: row.entity,
    chunkIds: JSON.parse(row.chunk_ids),
    coEntities: JSON.parse(row.co_entities),
    mentionCount: row.mention_count,
    lastSeen: row.last_seen,
  };
}

/**
 * Get co-occurring entities for a given entity, sorted by co-occurrence count.
 */
function getRelatedEntities(db, name) {
  const entity = getEntity(db, name);
  if (!entity) return [];
  return Object.entries(entity.coEntities)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ entity: name, count }));
}

/**
 * List all entities, sorted by mention count descending.
 */
function listEntities(db, { limit = 50 } = {}) {
  ensureEntityTable(db);
  return db.prepare(
    'SELECT entity, mention_count, last_seen FROM entity_index ORDER BY mention_count DESC LIMIT ?'
  ).all(limit);
}

/**
 * Given a set of matched entity names, expand with co-occurring entities.
 * Returns the expanded set (original + related entities with count >= threshold).
 */
function expandEntitiesWithCooccurrence(db, matchedEntities, { coThreshold = 2 } = {}) {
  const expanded = new Set(matchedEntities);
  for (const name of matchedEntities) {
    const related = getRelatedEntities(db, name);
    for (const { entity, count } of related) {
      if (count >= coThreshold) {
        expanded.add(entity);
      }
    }
  }
  return expanded;
}

module.exports = { ensureEntityTable, buildEntityIndex, getEntity, getRelatedEntities, listEntities, expandEntitiesWithCooccurrence };
