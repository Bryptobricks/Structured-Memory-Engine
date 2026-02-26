#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { openDb, getStats, getFileMeta, insertChunks } = require('./store');
const { indexWorkspace, chunkMarkdown } = require('./indexer');
const { extractFacts } = require('./retain');
const { recall } = require('./recall');
const { runReflectCycle } = require('./reflect');
const { remember } = require('./remember');
const { loadConfig, resolveIncludes, resolveFileType } = require('./config');

let startupIndexResult = null;

function resolveWorkspace() {
  return process.env.SME_WORKSPACE || path.join(os.homedir(), '.claude');
}

function log(msg) {
  process.stderr.write(`[sme] ${msg}\n`);
}

// --- Handler functions (exported for testing) ---
// All handlers take workspace as a parameter for testability.

function handleQuery(db, workspace, args) {
  const results = recall(db, args.query, {
    limit: args.limit || 10,
    since: args.since || null,
    workspace,
    chunkType: args.type || null,
    minConfidence: args.minConfidence != null ? args.minConfidence : null,
    includeStale: args.includeStale || false,
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

function extractDateFromPath(filePath) {
  const m = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] + 'T00:00:00.000Z' : null;
}

function indexSingleFile(db, workspace, filePath, fileTypeDefaults) {
  const stat = fs.statSync(filePath);
  const mtimeMs = Math.floor(stat.mtimeMs);
  const relPath = path.relative(workspace, filePath);

  const meta = getFileMeta(db, relPath);
  if (meta && meta.mtime_ms === mtimeMs) return { skipped: true };

  const text = fs.readFileSync(filePath, 'utf-8');
  const chunks = chunkMarkdown(text);
  const createdAt = extractDateFromPath(filePath);

  // v4.2: Apply file-level type defaults (config overrides raw, inline tags override config)
  const fileDefault = resolveFileType(relPath, fileTypeDefaults || {});
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

function handleRemember(db, workspace, args, config) {
  const result = remember(workspace, args.content, { tag: args.tag || 'fact' });

  // Targeted re-index: only the file we just wrote, not the entire workspace
  let indexFailed = false;
  try {
    indexSingleFile(db, workspace, result.filePath, config ? config.fileTypeDefaults : undefined);
  } catch (err) {
    indexFailed = true;
    log(`Re-index after remember failed: ${err.message}`);
  }

  let text = `Saved to ${result.filePath}`;
  if (result.created) text += ' (new file)';
  text += `\n${result.line}`;
  if (indexFailed) text += '\n⚠ Indexing failed — run sme_index to make this searchable';
  return { content: [{ type: 'text', text }] };
}

function handleIndex(db, workspace, args, config) {
  const extras = config ? resolveIncludes(workspace, config) : [];
  const include = extras.map(p => path.relative(workspace, p));
  const fileTypeDefaults = config ? config.fileTypeDefaults || {} : {};
  const result = indexWorkspace(db, workspace, { force: args.force || false, include, fileTypeDefaults });
  let text = `Indexed: ${result.indexed} | Skipped: ${result.skipped} | Total: ${result.total} | Cleaned: ${result.cleaned || 0}`;
  if (result.errors && result.errors.length) {
    text += `\nErrors: ${result.errors.length}`;
    for (const e of result.errors) text += `\n  - ${e.file}: ${e.error}`;
  }
  return { content: [{ type: 'text', text }] };
}

function handleReflect(db, args) {
  const result = runReflectCycle(db, { dryRun: args.dryRun || false });
  const prefix = args.dryRun ? '[DRY RUN] ' : '';
  let text = `${prefix}Reflect cycle complete:\n`;
  text += `  Decayed: ${result.decay.decayed}\n`;
  text += `  Reinforced: ${result.reinforce.reinforced}\n`;
  text += `  Marked stale: ${result.stale.marked}\n`;
  text += `  Contradictions: ${result.contradictions.newFlags} new (${result.contradictions.found} total)\n`;
  text += `  Archived: ${result.prune.archived}`;
  return { content: [{ type: 'text', text }] };
}

function handleStatus(db) {
  const stats = getStats(db);
  let text = `Files indexed: ${stats.fileCount}\nTotal chunks: ${stats.chunkCount}`;
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

  const server = new McpServer({
    name: 'sme',
    version: '4.2.1',
  });

  server.tool(
    'sme_query',
    `Search ${ownerLabel} memory for past decisions, facts, preferences, people, events, or context. Uses full-text search with ranked results. Always try this first when you need to recall something.`,
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default 10)'),
      since: z.string().optional().describe('Time filter: 7d, 2w, 3m, 1y, or YYYY-MM-DD'),
      type: z.string().optional().describe('Filter by chunk type: fact, decision, preference, confirmed, inferred, outdated, opinion'),
      minConfidence: z.number().optional().describe('Minimum confidence threshold (0-1)'),
      includeStale: z.boolean().optional().describe('Include stale results (default false)'),
    },
    async (args) => {
      try {
        return handleQuery(db, workspace, args);
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
      content: z.string().describe('The fact, decision, or observation to remember'),
      tag: z.enum(['fact', 'decision', 'pref', 'opinion', 'confirmed', 'inferred']).optional().describe('Tag type (default: fact)'),
    },
    async (args) => {
      try {
        return handleRemember(db, workspace, args, config);
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
        return handleIndex(db, workspace, args, config);
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
        return handleReflect(db, args);
      } catch (err) {
        log(`sme_reflect error: ${err.message}`);
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

module.exports = { handleQuery, handleRemember, handleIndex, handleReflect, handleStatus, indexSingleFile, setStartupIndexResult };
