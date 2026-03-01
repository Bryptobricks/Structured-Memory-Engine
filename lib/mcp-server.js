#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { openDb, getStats } = require('./store');
const { indexWorkspace, indexSingleFile } = require('./indexer');
const { recall } = require('./recall');
const { runReflectCycle } = require('./reflect');
const { remember } = require('./remember');
const { loadConfig, resolveIncludes } = require('./config');
const { getRelevantContext } = require('./context');
const { buildEntityIndex, getEntity, listEntities, getRelatedEntities } = require('./entities');
const embeddings = require('./embeddings');

let startupIndexResult = null;

function resolveWorkspace() {
  return process.env.SME_WORKSPACE || path.join(os.homedir(), '.claude');
}

function log(msg) {
  process.stderr.write(`[sme] ${msg}\n`);
}

// --- Handler functions (exported for testing) ---
// All handlers take workspace as a parameter for testability.

function handleQuery(db, workspace, args, config) {
  const results = recall(db, args.query, {
    limit: args.limit || 10,
    since: args.since || null,
    workspace,
    chunkType: args.type || null,
    minConfidence: args.minConfidence != null ? args.minConfidence : null,
    includeStale: args.includeStale || false,
    excludeFromRecall: config && config.excludeFromRecall ? config.excludeFromRecall : null,
  });

  if (results.length === 0) {
    return { content: [{ type: 'text', text: 'No results found.' }] };
  }

  let text = '';
  for (const r of results) {
    text += `\n--- ${r.filePath}:${r.lineStart}-${r.lineEnd}`;
    if (r.heading) text += ` (${r.heading})`;
    text += ` [score: ${r.finalScore.toFixed(4)} type: ${r.chunkType} conf: ${r.confidence}]`;
    text += '\n';
    text += r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content;
    text += '\n';
  }
  text += `\n${results.length} result(s)`;

  return { content: [{ type: 'text', text: text.trim() }] };
}

async function handleRemember(db, workspace, args, config) {
  const result = remember(workspace, args.content, { tag: args.tag || 'fact' });

  // Targeted re-index: only the file we just wrote, not the entire workspace
  let indexFailed = false;
  try {
    indexSingleFile(db, workspace, result.filePath, config ? config.fileTypeDefaults : undefined);
  } catch (err) {
    indexFailed = true;
    log(`Re-index after remember failed: ${err.message}`);
  }

  // Embed newly indexed chunks from this file
  let embeddedCount = 0;
  try {
    if (!indexFailed && embeddings.isAvailable()) {
      embeddings.ensureEmbeddingColumn(db);
      const rows = db.prepare('SELECT id, content FROM chunks WHERE file_path = ? AND embedding IS NULL').all(result.filePath);
      for (const row of rows) {
        const vec = await embeddings.embed(row.content);
        if (vec) {
          db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(Buffer.from(vec.buffer), row.id);
          embeddedCount++;
        }
      }
    }
  } catch (_) {}

  let text = `Saved to ${result.filePath}`;
  if (result.created) text += ' (new file)';
  text += `\n${result.line}`;
  if (embeddedCount > 0) text += `\nEmbedded: ${embeddedCount} chunk(s)`;
  if (indexFailed) text += '\n⚠ Indexing failed — run sme_index to make this searchable';
  return { content: [{ type: 'text', text }] };
}

async function handleIndex(db, workspace, args, config) {
  const extras = config ? resolveIncludes(workspace, config) : [];
  const include = extras.map(p => path.relative(workspace, p));
  const fileTypeDefaults = config ? config.fileTypeDefaults || {} : {};
  const result = indexWorkspace(db, workspace, { force: args.force || false, include, fileTypeDefaults });
  let text = `Indexed: ${result.indexed} | Skipped: ${result.skipped} | Total: ${result.total} | Cleaned: ${result.cleaned || 0}`;
  if (result.errors && result.errors.length) {
    text += `\nErrors: ${result.errors.length}`;
    for (const e of result.errors) text += `\n  - ${e.file}: ${e.error}`;
  }
  if (config && config.reflect && config.reflect.autoReflectOnIndex) {
    const reflectResult = runReflectCycle(db, { config });
    text += `\nAuto-reflect: decayed=${reflectResult.decay.decayed} contradictions=${reflectResult.contradictions.newFlags} archived=${reflectResult.prune.archived}`;
  }
  // Embed new chunks after indexing
  if (embeddings.isAvailable()) {
    try {
      const embResult = await embeddings.embedAll(db);
      if (embResult.embedded > 0) text += `\nEmbeddings: ${embResult.embedded} new`;
    } catch (_) {}
  }
  return { content: [{ type: 'text', text }] };
}

async function handleReflect(db, args, config) {
  const result = runReflectCycle(db, { dryRun: args.dryRun || false, config: config || null });
  const prefix = args.dryRun ? '[DRY RUN] ' : '';
  let text = `${prefix}Reflect cycle complete:\n`;
  text += `  Decayed: ${result.decay.decayed}\n`;
  text += `  Reinforced: ${result.reinforce.reinforced}\n`;
  text += `  Marked stale: ${result.stale.marked}\n`;
  text += `  Contradictions: ${result.contradictions.newFlags} new (${result.contradictions.found} total)\n`;
  text += `  Archived: ${result.prune.archived}\n`;
  text += `  Entities: ${result.entityIndex ? result.entityIndex.entities : 0} indexed`;
  // Catch-up embedding during maintenance
  if (!args.dryRun && embeddings.isAvailable()) {
    try {
      const embResult = await embeddings.embedAll(db);
      if (embResult.embedded > 0) text += `\n  Embeddings: ${embResult.embedded} new`;
    } catch (_) {}
  }
  return { content: [{ type: 'text', text }] };
}

function handleStatus(db) {
  const stats = getStats(db);
  let text = `Files indexed: ${stats.fileCount}\nTotal chunks: ${stats.chunkCount}`;
  // Embedding status
  try {
    const embStatus = embeddings.embeddingStatus(db);
    text += `\nEmbeddings: ${embStatus.embedded}/${embStatus.total} chunks`;
    if (!embStatus.available) text += ' (not available — install @xenova/transformers)';
  } catch (_) {}
  if (startupIndexResult) {
    if (startupIndexResult.ok) {
      text += `\nStartup index: OK (indexed=${startupIndexResult.indexed} skipped=${startupIndexResult.skipped})`;
    } else {
      text += `\nStartup index: FAILED (${startupIndexResult.error})`;
    }
  }
  if (stats.files.length) {
    text += '\n\nFiles:';
    for (const f of stats.files) {
      text += `\n  ${f.file_path} (${f.chunk_count} chunks)`;
    }
  }
  return { content: [{ type: 'text', text }] };
}

// --- MCP Server setup ---

async function main() {
  const workspace = resolveWorkspace();
  const db = openDb(workspace);
  const config = loadConfig(workspace);
  log(`Workspace: ${workspace}`);
  log(`Config: owner=${config.owner || '(none)'}, include=${config.include.length}, globs=${config.includeGlobs.length}`);

  // Auto-index on startup with config-resolved extra files
  try {
    const extras = resolveIncludes(workspace, config);
    const include = extras.map(p => path.relative(workspace, p));
    const fileTypeDefaults = config.fileTypeDefaults || {};
    const result = indexWorkspace(db, workspace, { include, fileTypeDefaults });
    log(`Auto-index: indexed=${result.indexed} skipped=${result.skipped} total=${result.total} cleaned=${result.cleaned}`);
    startupIndexResult = { ok: true, indexed: result.indexed, skipped: result.skipped };
  } catch (err) {
    log(`Auto-index failed (non-fatal): ${err.message}`);
    startupIndexResult = { ok: false, error: err.message };
  }

  // Graceful shutdown — close DB handle, checkpoint WAL
  function shutdown() {
    log('Shutting down...');
    try { db.close(); } catch (_) {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const ownerLabel = config.owner ? `${config.owner}'s` : 'the workspace';

  // Warm up embedding pipeline (non-blocking)
  if (embeddings.isAvailable()) {
    embeddings.warmup().then(() => {
      log('Embedding pipeline ready');
    }).catch(err => {
      log(`Embedding warmup failed (non-fatal): ${err.message}`);
    });
  }

  const server = new McpServer({
    name: 'sme',
    version: '6.4.1',
  });

  server.tool(
    'sme_query',
    `Search ${ownerLabel} memory for past decisions, facts, preferences, people, events, or context. Uses full-text search with ranked results. Always try this first when you need to recall something.`,
    {
      query: z.string().min(1).max(2000).describe('Search query (max 2000 chars)'),
      limit: z.number().optional().describe('Max results (default 10)'),
      since: z.string().optional().describe('Time filter: 7d, 2w, 3m, 1y, or YYYY-MM-DD'),
      type: z.string().optional().describe('Filter by chunk type: fact, decision, preference, confirmed, inferred, outdated, opinion'),
      minConfidence: z.number().optional().describe('Minimum confidence threshold (0-1)'),
      includeStale: z.boolean().optional().describe('Include stale results (default false)'),
    },
    async (args) => {
      try {
        return await handleQuery(db, workspace, args, config);
      } catch (err) {
        log(`sme_query error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_remember',
    `Save a fact, decision, preference, or observation to today's memory log. Use this when ${config.owner || 'the user'} says 'remember this' or when you learn something worth persisting. Immediately indexed and searchable.`,
    {
      content: z.string().min(1).max(5000).describe('The fact, decision, or observation to remember (max 5000 chars)'),
      tag: z.enum(['fact', 'decision', 'pref', 'opinion', 'confirmed', 'inferred']).optional().describe('Tag type (default: fact)'),
    },
    async (args) => {
      try {
        return await handleRemember(db, workspace, args, config);
      } catch (err) {
        log(`sme_remember error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_index',
    'Re-index workspace memory files. Run after manually editing memory files, or with force=true for a full rebuild. Usually not needed — sme_remember auto-indexes.',
    {
      force: z.boolean().optional().describe('Force full reindex (default false)'),
    },
    async (args) => {
      try {
        return await handleIndex(db, workspace, args, config);
      } catch (err) {
        log(`sme_index error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_reflect',
    'Run a memory maintenance cycle: decay old confidence scores, reinforce frequently-accessed memories, detect contradictions, and archive dead memories. Use dryRun=true to preview.',
    {
      dryRun: z.boolean().optional().describe('Preview changes without modifying (default false)'),
    },
    async (args) => {
      try {
        return await handleReflect(db, args, config);
      } catch (err) {
        log(`sme_reflect error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_context',
    `Get relevant context for a message. Returns pre-formatted memory context ready for injection. Use this before responding to retrieve relevant past decisions, facts, and preferences from ${ownerLabel} memory.`,
    {
      message: z.string().min(1).max(5000).describe('The user message to find context for (max 5000 chars)'),
      maxTokens: z.number().optional().describe('Token budget for context (default 1500)'),
      conversationContext: z.array(z.string().max(2000)).max(10).optional().describe('Recent user messages for multi-turn awareness (last 2-3 turns)'),
    },
    async (args) => {
      try {
        // Pre-compute query embedding if embeddings are available
        let queryEmbedding = null;
        try {
          queryEmbedding = await embeddings.embed(args.message);
        } catch (_) {}

        const result = getRelevantContext(db, args.message, {
          maxTokens: args.maxTokens || 1500,
          workspace,
          conversationContext: args.conversationContext || [],
          queryEmbedding,
          excludeFromRecall: config.excludeFromRecall || null,
          alwaysExclude: config.alwaysExclude || null,
          fileWeights: config.fileWeights || null,
        });
        if (!result.text) {
          return { content: [{ type: 'text', text: 'No relevant context found.' }] };
        }
        return { content: [{ type: 'text', text: result.text }] };
      } catch (err) {
        log(`sme_context error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_status',
    'Show memory index statistics. Quick health check for the memory system.',
    {},
    async () => {
      try {
        return handleStatus(db);
      } catch (err) {
        log(`sme_status error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_entities',
    `Query the entity graph from ${ownerLabel} memory. Look up a specific person, project, or concept to see related entities and which memories mention them. Without a name, lists all known entities.`,
    {
      name: z.string().max(200).optional().describe('Entity name to look up (e.g. "Sarah", "DataSync"). Omit to list all entities.'),
      related: z.boolean().optional().describe('If true with a name, returns co-occurring entities instead of full entity info'),
    },
    async (args) => {
      try {
        if (args.name) {
          if (args.related) {
            const related = getRelatedEntities(db, args.name);
            if (related.length === 0) return { content: [{ type: 'text', text: `No related entities found for "${args.name}".` }] };
            let text = `Entities related to "${args.name}":\n`;
            for (const r of related) text += `  ${r.entity} (co-occurs ${r.count}x)\n`;
            return { content: [{ type: 'text', text: text.trim() }] };
          }
          const entity = getEntity(db, args.name);
          if (!entity) return { content: [{ type: 'text', text: `Entity "${args.name}" not found.` }] };
          let text = `Entity: ${entity.entity}\n`;
          text += `Mentions: ${entity.mentionCount}\n`;
          text += `Last seen: ${entity.lastSeen}\n`;
          text += `Chunk IDs: ${entity.chunkIds.join(', ')}\n`;
          if (Object.keys(entity.coEntities).length > 0) {
            text += `Co-occurring entities:\n`;
            const sorted = Object.entries(entity.coEntities).sort((a, b) => b[1] - a[1]);
            for (const [name, count] of sorted) text += `  ${name} (${count}x)\n`;
          }
          return { content: [{ type: 'text', text: text.trim() }] };
        }
        const list = listEntities(db);
        if (list.length === 0) return { content: [{ type: 'text', text: 'No entities indexed. Run sme_reflect to build the entity index.' }] };
        let text = `Known entities (${list.length}):\n`;
        for (const e of list) text += `  ${e.entity} (${e.mention_count} mentions)\n`;
        return { content: [{ type: 'text', text: text.trim() }] };
      } catch (err) {
        log(`sme_entities error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_embed',
    'Manage semantic embeddings for memory chunks. Embeddings enable semantic similarity search (finding conceptually related memories even without keyword matches). Requires @xenova/transformers.',
    {
      action: z.enum(['status', 'build']).describe('status: check embedding coverage. build: embed all unembedded chunks.'),
    },
    async (args) => {
      try {
        if (args.action === 'status') {
          const status = embeddings.embeddingStatus(db);
          let text = `Embedding status:\n`;
          text += `  Available: ${status.available ? 'yes' : 'no (@xenova/transformers not installed)'}\n`;
          text += `  Total chunks: ${status.total}\n`;
          text += `  Embedded: ${status.embedded}\n`;
          text += `  Pending: ${status.pending}`;
          return { content: [{ type: 'text', text }] };
        }
        if (args.action === 'build') {
          if (!embeddings.isAvailable()) {
            return { content: [{ type: 'text', text: 'Cannot build embeddings: @xenova/transformers is not installed.\nInstall with: npm install @xenova/transformers' }] };
          }
          log('Building embeddings...');
          const result = await embeddings.embedAll(db, {
            onProgress: ({ embedded, total }) => log(`Embedding progress: ${embedded}/${total}`),
          });
          return { content: [{ type: 'text', text: `Embedded ${result.embedded} chunks (${result.total} total).` }] };
        }
      } catch (err) {
        log(`sme_embed error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_recall_stats',
    'Show recall quality statistics. Returns hit rates, score distributions, top recalled files, and empty recall rates. Use this to diagnose why recall is missing relevant memories or returning noise.',
    {
      last: z.number().optional().describe('Number of recent recall events to analyze (default 100)'),
    },
    async (args) => {
      try {
        const { summarizeLog } = require('./recall-logger');
        const stats = summarizeLog(workspace, { last: args.last || 100 });
        if (stats.error) return { content: [{ type: 'text', text: stats.error }] };
        let text = `Recall stats (last ${stats.total} events):\n`;
        text += `  Empty recalls: ${stats.emptyRecalls} (${stats.emptyRate})\n`;
        text += `  Avg chunks returned: ${stats.avgChunks}\n`;
        text += `  Avg tokens injected: ${stats.avgTokens}\n`;
        text += `  Avg duration: ${stats.avgDurationMs}ms\n`;
        text += `  Total excluded by pattern: ${stats.totalExcludedByPattern}\n`;
        text += `  Score range: ${stats.scoreDistribution.min}–${stats.scoreDistribution.max} (avg ${stats.scoreDistribution.avg})\n`;
        if (stats.topFiles.length > 0) {
          text += `\nTop recalled files:\n`;
          for (const [file, count] of stats.topFiles) {
            text += `  ${file} (${count}x)\n`;
          }
        }
        return { content: [{ type: 'text', text: text.trim() }] };
      } catch (err) {
        log(`sme_recall_stats error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'sme_ingest',
    'Ingest a meeting transcript or CSV file into memory. Parses structured data, generates tagged markdown, and indexes it for search.',
    {
      sourcePath: z.string().min(1).max(500).describe('Path to source file'),
      type: z.enum(['auto', 'transcript', 'csv']).optional().describe('Source type (default: auto-detect by extension)'),
      force: z.boolean().optional().describe('Re-ingest even if source file is unchanged'),
    },
    async (args) => {
      try {
        const { syncFile } = require('./ingest');
        const fileTypeDefaults = config ? config.fileTypeDefaults || {} : {};
        const opts = { force: args.force || false, fileTypeDefaults };
        if (args.type && args.type !== 'auto') opts.type = args.type;
        const result = syncFile(db, workspace, args.sourcePath, opts);
        if (result.skipped) {
          return { content: [{ type: 'text', text: `Skipped (unchanged): ${args.sourcePath}` }] };
        }
        return { content: [{ type: 'text', text: `Ingested: ${args.sourcePath} → ${result.outputPath}${result.indexed ? ' (indexed)' : ''}` }] };
      } catch (err) {
        log(`sme_ingest error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Auto-sync ingest sources on startup if configured
  if (config.ingest && config.ingest.autoSync && config.ingest.sourceDir) {
    try {
      const { syncAll } = require('./ingest');
      const fileTypeDefaults = config.fileTypeDefaults || {};
      const result = syncAll(db, workspace, config.ingest.sourceDir, { fileTypeDefaults });
      log(`Auto-ingest: synced=${result.synced.length} skipped=${result.skipped.length} errors=${result.errors.length}`);
    } catch (err) {
      log(`Auto-ingest failed (non-fatal): ${err.message}`);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server running on stdio');
}

// Export handlers for testing
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`[sme] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

function setStartupIndexResult(result) { startupIndexResult = result; }

module.exports = { handleQuery, handleRemember, handleIndex, handleReflect, handleStatus, indexSingleFile, setStartupIndexResult, buildEntityIndex };
