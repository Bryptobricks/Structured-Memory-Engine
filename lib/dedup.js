/**
 * v7.3 Semantic Deduplication — TF-IDF cosine similarity for paraphrased duplicates.
 * Zero external dependencies.
 */

const { extractTerms } = require('./reflect');

function tokenize(text) {
  return extractTerms(text);
}

/**
 * Build TF-IDF vector for a set of tokens given an IDF map.
 */
function buildTfIdf(tokens, idf) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  const vec = {};
  for (const term of Object.keys(tf)) {
    vec[term] = (tf[term] / tokens.length) * (idf[term] || 1);
  }
  return vec;
}

/**
 * Build IDF map from an array of token arrays (one per document).
 */
function buildIdf(docTokens) {
  const N = docTokens.length;
  if (N === 0) return {};
  const df = {};
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const t of seen) {
      df[t] = (df[t] || 0) + 1;
    }
  }
  const idf = {};
  for (const term of Object.keys(df)) {
    idf[term] = Math.log(N / df[term]) + 1;
  }
  return idf;
}

/**
 * Cosine similarity between two sparse vectors (objects).
 */
function cosineSimilarity(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  for (const term of Object.keys(vecA)) {
    magA += vecA[term] * vecA[term];
    if (vecB[term]) dot += vecA[term] * vecB[term];
  }
  for (const term of Object.keys(vecB)) {
    magB += vecB[term] * vecB[term];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Find duplicates for a new chunk against existing chunks in the DB.
 * Returns { action: 'insert' | 'skip' | 'review', existingId?, similarity? }
 */
function findDuplicates(existingChunks, newContent, opts = {}) {
  const autoMergeThreshold = opts.autoMergeThreshold || 0.92;
  const reviewThreshold = opts.reviewThreshold || 0.85;
  const newTokens = tokenize(newContent);
  if (newTokens.length === 0) return { action: 'insert' };

  // Build IDF from existing + new
  const allDocTokens = existingChunks.map(c => tokenize(c.content));
  allDocTokens.push(newTokens);
  const idf = buildIdf(allDocTokens);

  const newVec = buildTfIdf(newTokens, idf);

  let bestSim = 0;
  let bestChunk = null;

  for (let i = 0; i < existingChunks.length; i++) {
    const existingTokens = allDocTokens[i];
    if (existingTokens.length === 0) continue;
    const existingVec = buildTfIdf(existingTokens, idf);
    const sim = cosineSimilarity(newVec, existingVec);
    if (sim > bestSim) {
      bestSim = sim;
      bestChunk = existingChunks[i];
    }
  }

  if (bestSim >= autoMergeThreshold && bestChunk) {
    return { action: 'skip', existingId: bestChunk.id, similarity: bestSim };
  }
  if (bestSim >= reviewThreshold && bestChunk) {
    return { action: 'review', existingId: bestChunk.id, similarity: bestSim };
  }
  return { action: 'insert' };
}

/**
 * Run dedup check for an array of chunks being inserted into a file.
 * Returns { toInsert: [], toSkip: [], toReview: [] }
 */
function dedupChunks(db, chunks, config = {}) {
  if (!config.enabled) return { toInsert: chunks, toSkip: [], toReview: [] };

  const typeThresholds = config.typeThresholds || {};
  const defaultAutoMerge = config.autoMergeThreshold || 0.92;
  const defaultReview = config.reviewThreshold || 0.85;

  const toInsert = [];
  const toSkip = [];
  const toReview = [];

  // Group by chunk type for type-aware thresholds
  const typeGroups = {};
  for (const c of chunks) {
    const type = c.chunkType || 'raw';
    if (!typeGroups[type]) typeGroups[type] = [];
    typeGroups[type].push(c);
  }

  for (const [type, groupChunks] of Object.entries(typeGroups)) {
    // Fetch existing chunks of same type
    const existing = db.prepare(
      'SELECT id, content, chunk_type FROM chunks WHERE chunk_type = ?'
    ).all(type);

    const autoMerge = typeThresholds[type] || defaultAutoMerge;
    const review = Math.min(autoMerge, typeThresholds[type] ? typeThresholds[type] - 0.04 : defaultReview);

    for (const chunk of groupChunks) {
      const result = findDuplicates(existing, chunk.content, {
        autoMergeThreshold: autoMerge,
        reviewThreshold: review,
      });

      if (result.action === 'skip') {
        toSkip.push({ chunk, existingId: result.existingId, similarity: result.similarity });
      } else if (result.action === 'review') {
        toInsert.push(chunk);
        toReview.push({ chunk, existingId: result.existingId, similarity: result.similarity });
      } else {
        toInsert.push(chunk);
      }
    }
  }

  return { toInsert, toSkip, toReview };
}

/**
 * List pending dedup reviews from the database.
 */
function listDedupReviews(db, { status = 'pending' } = {}) {
  return db.prepare(`
    SELECT dr.*,
           c1.content as new_content, c1.chunk_type as new_type,
           c2.content as existing_content, c2.chunk_type as existing_type
    FROM dedup_reviews dr
    LEFT JOIN chunks c1 ON c1.id = dr.new_chunk_id
    JOIN chunks c2 ON c2.id = dr.existing_chunk_id
    WHERE dr.status = ?
    ORDER BY dr.created_at DESC
  `).all(status);
}

/**
 * Resolve a dedup review.
 */
function resolveDedupReview(db, reviewId, action) {
  const valid = ['merged', 'kept_both', 'dismissed'];
  if (!valid.includes(action)) {
    return { resolved: false, error: `Invalid action "${action}". Must be one of: ${valid.join(', ')}` };
  }

  const row = db.prepare('SELECT * FROM dedup_reviews WHERE id = ?').get(reviewId);
  if (!row) return { resolved: false, error: `Dedup review #${reviewId} not found` };
  if (row.status !== 'pending') return { resolved: false, error: `Review #${reviewId} already resolved (${row.status})` };

  if (action === 'merged' && row.new_chunk_id) {
    // Delete the newer duplicate chunk
    db.prepare('DELETE FROM chunks WHERE id = ?').run(row.new_chunk_id);
  }

  db.prepare('UPDATE dedup_reviews SET status = ? WHERE id = ?').run(action, reviewId);
  return { resolved: true, action };
}

module.exports = { tokenize, buildTfIdf, buildIdf, cosineSimilarity, findDuplicates, dedupChunks, listDedupReviews, resolveDedupReview };
