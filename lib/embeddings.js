'use strict';

/**
 * Optional embedding support for semantic search.
 * Requires @xenova/transformers as an optional peer dependency.
 * If not installed, all functions gracefully return null/empty.
 */

let _pipeline = null;
let _pipelineLoading = false;
let _pipelinePromise = null;

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

/**
 * Check if the embedding dependency is available.
 */
function isAvailable() {
  try {
    require.resolve('@xenova/transformers');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Load the embedding pipeline (lazy, cached).
 */
async function getPipeline(model) {
  if (_pipeline) return _pipeline;
  if (_pipelinePromise) return _pipelinePromise;

  if (!isAvailable()) return null;

  _pipelineLoading = true;
  _pipelinePromise = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    _pipeline = await pipeline('feature-extraction', model || DEFAULT_MODEL);
    _pipelineLoading = false;
    return _pipeline;
  })();

  return _pipelinePromise;
}

/**
 * Ensure the embedding column exists.
 */
function ensureEmbeddingColumn(db) {
  try { db.exec('ALTER TABLE chunks ADD COLUMN embedding BLOB'); } catch (_) { /* migration: column may already exist */ }
}

/**
 * Embed a single text string → Float32Array.
 */
async function embed(text, model) {
  const pipe = await getPipeline(model);
  if (!pipe) return null;
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Batch embed all unembedded chunks.
 * @returns {{ embedded: number, skipped: number, total: number }}
 */
/**
 * Batch embed all unembedded chunks.
 * v7.0: Embeddings are computed on heading + content for heading-aware semantic search.
 * This ensures queries like "supplements" match chunks under "Current Supplements & Stack"
 * heading even when the body text doesn't contain the keyword.
 * @returns {{ embedded: number, skipped: number, total: number }}
 */
async function embedAll(db, { model, batchSize = 50, onProgress } = {}) {
  ensureEmbeddingColumn(db);

  const pipe = await getPipeline(model);
  if (!pipe) return { embedded: 0, skipped: 0, total: 0, error: 'Embedding dependency not available' };

  // v7.0: Select heading along with content for heading-aware embeddings
  const rows = db.prepare('SELECT id, heading, content FROM chunks WHERE embedding IS NULL AND stale = 0').all();
  const total = rows.length;
  let embedded = 0;

  const stmt = db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?');

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      // v7.0: Prepend heading to content for embedding — gives semantic context
      // "Current Supplements & Stack\nCreatine 5g daily..." embeds better than just body
      const textToEmbed = row.heading ? `${row.heading}\n${row.content}` : row.content;
      const output = await pipe(textToEmbed, { pooling: 'mean', normalize: true });
      const vec = new Float32Array(output.data);
      stmt.run(Buffer.from(vec.buffer), row.id);
      embedded++;
    }
    if (onProgress) onProgress({ embedded, total });
  }

  return { embedded, skipped: 0, total };
}

/**
 * Cosine similarity between two Float32Arrays.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Semantic search: embed query → cosine similarity against stored vectors.
 * @returns {Array<{ id: number, similarity: number }>}
 */
async function semanticSearch(db, query, { model, limit = 20 } = {}) {
  ensureEmbeddingColumn(db);

  const queryVec = await embed(query, model);
  if (!queryVec) return [];

  const rows = db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND stale = 0').all();
  const scored = [];

  for (const row of rows) {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const sim = cosineSimilarity(queryVec, vec);
    scored.push({ id: row.id, similarity: sim });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Get embedding status — how many chunks have embeddings vs total.
 */
function embeddingStatus(db) {
  ensureEmbeddingColumn(db);
  const total = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE stale = 0').get().n;
  const embedded = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE embedding IS NOT NULL AND stale = 0').get().n;
  return { total, embedded, pending: total - embedded, available: isAvailable() };
}

/**
 * Warm up the embedding pipeline (lazy model load).
 * Call on startup to avoid first-query latency.
 */
async function warmup(model) {
  return getPipeline(model);
}

/**
 * Clear all embeddings to force re-computation.
 * v7.0: Use this after upgrading to heading-aware embeddings.
 * @returns {{ cleared: number }}
 */
function clearEmbeddings(db) {
  ensureEmbeddingColumn(db);
  const result = db.prepare('UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL').run();
  return { cleared: result.changes };
}

module.exports = {
  isAvailable,
  embed,
  embedAll,
  semanticSearch,
  cosineSimilarity,
  embeddingStatus,
  ensureEmbeddingColumn,
  warmup,
  clearEmbeddings,
  EMBEDDING_DIM,
};
