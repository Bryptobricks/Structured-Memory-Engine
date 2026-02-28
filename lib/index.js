#!/usr/bin/env node
const path = require('path');
const { openDb, getStats } = require('./store');
const { indexWorkspace } = require('./indexer');
const { recall } = require('./recall');
const { runReflectCycle, restoreChunk, resolveContradiction } = require('./reflect');
const { loadConfig, resolveIncludes } = require('./config');
const { buildEntityIndex, getEntity, listEntities, getRelatedEntities } = require('./entities');
const { getRelevantContext } = require('./context');
const embeddings = require('./embeddings');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) { args.workspace = argv[++i]; }
    else if (argv[i] === '--force') { args.force = true; }
    else if (argv[i] === '--limit' && argv[i + 1]) { args.limit = parseInt(argv[++i]); }
    else if (argv[i] === '--since' && argv[i + 1]) { args.since = argv[++i]; }
    else if (argv[i] === '--include' && argv[i + 1]) { args.include = argv[++i].split(','); }
    else if (argv[i] === '--context' && argv[i + 1]) { args.context = parseInt(argv[++i]); }
    else if (argv[i] === '--type' && argv[i + 1]) { args.type = argv[++i]; }
    else if (argv[i] === '--min-confidence' && argv[i + 1]) { args.minConfidence = parseFloat(argv[++i]); }
    else if (argv[i] === '--dry-run') { args.dryRun = true; }
    else if (argv[i] === '--unresolved') { args.unresolved = true; }
    else if (argv[i] === '--include-stale') { args.includeStale = true; }
    else if (argv[i] === '--json') { args.json = true; }
    else if (argv[i] === '--action' && argv[i + 1]) { args.action = argv[++i]; }
    else if (argv[i] === '--status') { args.status = true; }
    else if (argv[i].startsWith('-')) { process.stderr.write(`Warning: unknown flag ${argv[i]}\n`); }
    else { args._.push(argv[i]); }
  }
  // Validate numeric args
  if (args.limit != null && isNaN(args.limit)) { process.stderr.write('Warning: --limit must be a number, ignoring\n'); delete args.limit; }
  if (args.minConfidence != null && isNaN(args.minConfidence)) { process.stderr.write('Warning: --min-confidence must be a number, ignoring\n'); delete args.minConfidence; }
  if (args.context != null && isNaN(args.context)) { process.stderr.write('Warning: --context must be a number, ignoring\n'); delete args.context; }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const workspace = path.resolve(args.workspace || process.cwd());

if (!command || command === 'help') {
  console.log(`Usage:
  node lib/index.js index [--workspace PATH] [--force] [--include file1.md,file2.md]
  node lib/index.js query "search terms" [--limit N] [--since 7d|2w|3m|1y|2026-01-01] [--context N] [--type TYPE] [--min-confidence 0.5] [--include-stale]
  node lib/index.js status [--workspace PATH]
  node lib/index.js reflect [--dry-run] [--workspace PATH]
  node lib/index.js contradictions [--unresolved] [--limit N] [--workspace PATH]
  node lib/index.js archived [--limit N] [--workspace PATH]
  node lib/index.js resolve <contradiction-id> --action keep-newer|keep-older|keep-both|dismiss
  node lib/index.js restore <chunk-id> [--workspace PATH]
  node lib/index.js entities [name] [--related] [--workspace PATH]
  node lib/index.js context "message" [--limit N] [--workspace PATH]
  node lib/index.js embed [--status] [--workspace PATH]
  node lib/index.js ingest <source-file-or-dir> [--workspace PATH] [--force]`);
  process.exit(0);
}

const db = openDb(workspace);

(async () => {
  try {

if (command === 'index') {
  const config = loadConfig(workspace);
  let include = args.include || [];
  if (include.length === 0) {
    const extras = resolveIncludes(workspace, config);
    include = extras.map(p => path.relative(workspace, p));
  }
  const fileTypeDefaults = config.fileTypeDefaults || {};
  const result = indexWorkspace(db, workspace, { force: args.force, include, fileTypeDefaults });
  console.log(`Indexed ${result.indexed} files, skipped ${result.skipped} unchanged (${result.total} total discovered)`);
  if (result.errors && result.errors.length) {
    console.warn(`⚠️  ${result.errors.length} file(s) failed:`);
    for (const e of result.errors) console.warn(`  - ${e.file}: ${e.error}`);
  }
  if (config.reflect && config.reflect.autoReflectOnIndex) {
    const reflectResult = runReflectCycle(db, { config });
    process.stderr.write(`Auto-reflect: decayed=${reflectResult.decay.decayed} contradictions=${reflectResult.contradictions.newFlags} archived=${reflectResult.prune.archived}\n`);
  }
  // Embed new chunks after indexing
  if (embeddings.isAvailable()) {
    try {
      const embResult = await embeddings.embedAll(db, {
        onProgress: ({ embedded, total }) => process.stderr.write(`\rEmbedding: ${embedded}/${total}`),
      });
      if (embResult.embedded > 0) {
        process.stderr.write(`\nEmbedded ${embResult.embedded} new chunks\n`);
      }
    } catch (_) {}
  }
} else if (command === 'query') {
  const query = args._.slice(1).join(' ');
  if (!query) { console.error('Usage: node lib/index.js query "search terms"'); process.exit(1); }
  const config = loadConfig(workspace);
  const results = recall(db, query, { limit: args.limit, since: args.since, context: args.context || 0, workspace, chunkType: args.type || null, minConfidence: args.minConfidence != null ? args.minConfidence : null, includeStale: args.includeStale || false, excludeFromRecall: config.excludeFromRecall || null });
  if (args.json) {
    console.log(JSON.stringify({ results: results.map(r => ({ filePath: r.filePath, heading: r.heading, content: r.content, lineStart: r.lineStart, lineEnd: r.lineEnd, chunkType: r.chunkType, confidence: r.confidence, score: r.finalScore, entities: r.entities, context: r.context || [] })), count: results.length }));
  } else if (results.length === 0) {
    console.log('No results found.');
  } else {
    for (const r of results) {
      console.log(`\n--- ${r.filePath}:${r.lineStart}-${r.lineEnd} ${r.heading ? '(' + r.heading + ')' : ''} [fts: ${r.ftsScore?.toFixed(4)} final: ${r.finalScore?.toFixed(4)} weight: ${r.fileWeight} type: ${r.chunkType} conf: ${r.confidence}]`);
      if (r.entities.length) console.log(`    entities: ${r.entities.join(', ')}`);
      console.log(r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content);
      if (r.context && r.context.length) {
        for (const ctx of r.context) {
          console.log(`    [ctx :${ctx.lineStart}-${ctx.lineEnd}] ${ctx.content.length > 150 ? ctx.content.slice(0, 150) + '...' : ctx.content}`);
        }
      }
    }
    console.log(`\n${results.length} result(s)`);
  }
} else if (command === 'status') {
  const stats = getStats(db);
  if (args.json) {
    try {
      stats.embeddings = embeddings.embeddingStatus(db);
    } catch (_) {}
    console.log(JSON.stringify(stats));
  } else {
    console.log(`Files indexed: ${stats.fileCount}`);
    console.log(`Total chunks: ${stats.chunkCount}`);
    // Embedding status
    try {
      const embStatus = embeddings.embeddingStatus(db);
      console.log(`Embeddings: ${embStatus.embedded}/${embStatus.total} chunks${embStatus.available ? '' : ' (not available)'}`);
    } catch (_) {}
    if (stats.files.length) {
      console.log('\nFiles:');
      for (const f of stats.files) {
        console.log(`  ${f.file_path} (${f.chunk_count} chunks, indexed ${f.indexed_at})`);
      }
    }
  }
} else if (command === 'resolve') {
  const contradictionId = parseInt(args._[1]);
  if (!contradictionId || isNaN(contradictionId)) { console.error('Usage: node lib/index.js resolve <contradiction-id> --action keep-newer|keep-older|keep-both|dismiss'); process.exit(1); }
  if (!args.action) { console.error('Error: --action is required. Options: keep-newer, keep-older, keep-both, dismiss'); process.exit(1); }
  const result = resolveContradiction(db, contradictionId, args.action);
  if (result.resolved) {
    console.log(`Resolved contradiction #${contradictionId} (${result.action})`);
    if (result.chunkDowngraded) console.log(`  Chunk #${result.chunkDowngraded} downgraded to outdated (confidence 0.3)`);
  } else {
    console.error(result.error);
    process.exit(1);
  }
} else if (command === 'reflect') {
  const config = loadConfig(workspace);
  const result = runReflectCycle(db, { dryRun: args.dryRun || false, config });
  const prefix = args.dryRun ? '[DRY RUN] ' : '';
  console.log(`${prefix}Reflect cycle complete:`);
  console.log(`  Decayed: ${result.decay.decayed}`);
  console.log(`  Reinforced: ${result.reinforce.reinforced}`);
  console.log(`  Marked stale: ${result.stale.marked}`);
  console.log(`  Contradictions: ${result.contradictions.newFlags} new (${result.contradictions.found} total)`);
  console.log(`  Archived: ${result.prune.archived}`);
  console.log(`  Entities: ${result.entityIndex ? result.entityIndex.entities : 0} indexed`);
  // Catch-up embedding during maintenance
  if (!args.dryRun && embeddings.isAvailable()) {
    try {
      const embResult = await embeddings.embedAll(db);
      if (embResult.embedded > 0) console.log(`  Embeddings: ${embResult.embedded} new`);
    } catch (_) {}
  }
  if (args.dryRun) {
    if (result.decay.details.length) {
      console.log('\nDecay details:');
      for (const d of result.decay.details) console.log(`  #${d.id} "${d.heading || '(no heading)'}" ${d.oldConf} -> ${d.newConf} (${d.daysSinceAccess}d since access)`);
    }
    if (result.reinforce.details.length) {
      console.log('\nReinforce details:');
      for (const d of result.reinforce.details) console.log(`  #${d.id} "${d.heading || '(no heading)'}" ${d.oldConf} -> ${d.newConf} (${d.accessCount} accesses)`);
    }
    if (result.stale.details.length) {
      console.log('\nStale details:');
      for (const d of result.stale.details) console.log(`  #${d.id} "${d.heading || '(no heading)'}" conf=${d.confidence} ${d.daysOld}d old`);
    }
    if (result.contradictions.details.length) {
      console.log('\nContradiction details:');
      for (const d of result.contradictions.details) console.log(`  #${d.idOld} vs #${d.idNew} "${d.headingOld}" — ${d.reason}`);
    }
    if (result.prune.details.length) {
      console.log('\nPrune details:');
      for (const d of result.prune.details) console.log(`  #${d.id} "${d.heading || '(no heading)'}" — ${d.reason}`);
    }
  }
} else if (command === 'contradictions') {
  let sql = 'SELECT c.*, old.heading as old_heading, old.content as old_content, new_c.heading as new_heading, new_c.content as new_content FROM contradictions c LEFT JOIN chunks old ON old.id = c.chunk_id_old LEFT JOIN chunks new_c ON new_c.id = c.chunk_id_new';
  if (args.unresolved) sql += ' WHERE c.resolved = 0';
  sql += ' ORDER BY c.created_at DESC';
  const cParams = [];
  if (args.limit) { sql += ' LIMIT ?'; cParams.push(args.limit); }
  const rows = db.prepare(sql).all(...cParams);
  if (rows.length === 0) {
    console.log('No contradictions found.');
  } else {
    for (const r of rows) {
      const status = r.resolved ? '[resolved]' : '[unresolved]';
      console.log(`\n${status} #${r.id} (${r.created_at})`);
      console.log(`  Old (#${r.chunk_id_old}): "${r.old_heading || '(no heading)'}" — ${(r.old_content || '(deleted)').slice(0, 120)}`);
      console.log(`  New (#${r.chunk_id_new}): "${r.new_heading || '(no heading)'}" — ${(r.new_content || '(deleted)').slice(0, 120)}`);
      if (r.reason) console.log(`  Reason: ${r.reason}`);
    }
    console.log(`\n${rows.length} contradiction(s)`);
  }
} else if (command === 'archived') {
  let sql = 'SELECT * FROM archived_chunks ORDER BY archived_at DESC';
  const aParams = [];
  if (args.limit) { sql += ' LIMIT ?'; aParams.push(parseInt(args.limit) || 20); }
  const rows = db.prepare(sql).all(...aParams);
  if (rows.length === 0) {
    console.log('No archived chunks.');
  } else {
    for (const r of rows) {
      console.log(`\n#${r.id} "${r.heading || '(no heading)'}" [${r.chunk_type}] conf=${r.confidence}`);
      console.log(`  File: ${r.file_path} | Archived: ${r.archived_at}`);
      console.log(`  Reason: ${r.archive_reason}`);
      console.log(`  ${r.content.length > 150 ? r.content.slice(0, 150) + '...' : r.content}`);
    }
    console.log(`\n${rows.length} archived chunk(s)`);
  }
} else if (command === 'restore') {
  const chunkId = parseInt(args._[1]);
  if (!chunkId || isNaN(chunkId)) { console.error('Usage: node lib/index.js restore <chunk-id>'); process.exit(1); }
  const result = restoreChunk(db, chunkId);
  if (result.restored) {
    console.log(`Restored archived chunk #${chunkId} -> new chunk #${result.newId}`);
  } else {
    console.error(result.error);
    process.exit(1);
  }
} else if (command === 'entities') {
  const name = args._[1];
  if (name) {
    if (args.dryRun) {
      // --dry-run with a name = "related" mode (reusing flag)
      const related = getRelatedEntities(db, name);
      if (related.length === 0) { console.log(`No related entities found for "${name}".`); }
      else {
        console.log(`Entities related to "${name}":`);
        for (const r of related) console.log(`  ${r.entity} (co-occurs ${r.count}x)`);
      }
    } else {
      const entity = getEntity(db, name);
      if (!entity) { console.log(`Entity "${name}" not found. Run 'sme reflect' to build the entity index.`); }
      else {
        console.log(`Entity: ${entity.entity}`);
        console.log(`Mentions: ${entity.mentionCount}`);
        console.log(`Last seen: ${entity.lastSeen}`);
        console.log(`Chunk IDs: ${entity.chunkIds.join(', ')}`);
        if (Object.keys(entity.coEntities).length > 0) {
          console.log('Co-occurring entities:');
          const sorted = Object.entries(entity.coEntities).sort((a, b) => b[1] - a[1]);
          for (const [n, count] of sorted) console.log(`  ${n} (${count}x)`);
        }
      }
    }
  } else {
    const list = listEntities(db);
    if (list.length === 0) { console.log('No entities indexed. Run `sme reflect` to build the entity index.'); }
    else {
      console.log(`Known entities (${list.length}):`);
      for (const e of list) console.log(`  ${e.entity} (${e.mention_count} mentions)`);
    }
  }
} else if (command === 'context') {
  const msg = args._.slice(1).join(' ');
  if (!msg) { console.error('Usage: node lib/index.js context "message"'); process.exit(1); }
  const ctxConfig = loadConfig(workspace);
  // Compute query embedding if available
  let queryEmbedding = null;
  try {
    queryEmbedding = await embeddings.embed(msg);
  } catch (_) {}
  const result = getRelevantContext(db, msg, { maxTokens: args.limit || 1500, workspace, queryEmbedding, excludeFromRecall: ctxConfig.excludeFromRecall || null });
  if (!result.text) { console.log('No relevant context found.'); }
  else { console.log(result.text); }
} else if (command === 'embed') {
  if (args.status || args._[1] === 'status') {
    const status = embeddings.embeddingStatus(db);
    console.log('Embedding status:');
    console.log(`  Available: ${status.available ? 'yes' : 'no (@xenova/transformers not installed)'}`);
    console.log(`  Total chunks: ${status.total}`);
    console.log(`  Embedded: ${status.embedded}`);
    console.log(`  Pending: ${status.pending}`);
  } else {
    if (!embeddings.isAvailable()) {
      console.error('Cannot build embeddings: @xenova/transformers is not installed.\nInstall with: npm install @xenova/transformers');
      process.exit(1);
    }
    console.log('Building embeddings...');
    const result = await embeddings.embedAll(db, {
      onProgress: ({ embedded, total }) => process.stderr.write(`\r  Progress: ${embedded}/${total}`),
    });
    process.stderr.write('\n');
    console.log(`Embedded ${result.embedded} chunks (${result.total} total).`);
  }
} else if (command === 'ingest') {
  const target = args._[1];
  if (!target) { console.error('Usage: node lib/index.js ingest <source-file-or-dir> [--workspace PATH] [--force]'); process.exit(1); }
  const { syncFile, syncAll } = require('./ingest');
  const config = loadConfig(workspace);
  const fileTypeDefaults = config.fileTypeDefaults || {};
  const opts = { force: args.force || false, fileTypeDefaults };
  const targetPath = path.resolve(target);
  const stat = require('fs').statSync(targetPath);
  if (stat.isDirectory()) {
    const result = syncAll(db, workspace, targetPath, opts);
    console.log(`Synced ${result.synced.length} files, skipped ${result.skipped.length} unchanged`);
    if (result.errors.length) {
      console.warn(`${result.errors.length} error(s):`);
      for (const e of result.errors) console.warn(`  - ${e.file}: ${e.error}`);
    }
  } else {
    const result = syncFile(db, workspace, targetPath, opts);
    if (result.skipped) {
      console.log(`Skipped ${path.basename(targetPath)} (unchanged)`);
    } else {
      console.log(`Ingested → ${result.outputPath}${result.indexed ? ' (indexed)' : ''}`);
    }
  }
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

  } finally {
    db.close();
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
