#!/usr/bin/env node
const path = require('path');
const { openDb, getStats } = require('./store');
const { indexWorkspace } = require('./indexer');
const { recall } = require('./recall');
const { runReflectCycle, restoreChunk } = require('./reflect');

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
    else if (!argv[i].startsWith('-')) { args._.push(argv[i]); }
  }
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
  node lib/index.js restore <chunk-id> [--workspace PATH]`);
  process.exit(0);
}

const db = openDb(workspace);

if (command === 'index') {
  const result = indexWorkspace(db, workspace, { force: args.force, include: args.include || [] });
  console.log(`Indexed ${result.indexed} files, skipped ${result.skipped} unchanged (${result.total} total discovered)`);
  if (result.errors && result.errors.length) {
    console.warn(`⚠️  ${result.errors.length} file(s) failed:`);
    for (const e of result.errors) console.warn(`  - ${e.file}: ${e.error}`);
  }
} else if (command === 'query') {
  const query = args._.slice(1).join(' ');
  if (!query) { console.error('Usage: node lib/index.js query "search terms"'); process.exit(1); }
  const results = recall(db, query, { limit: args.limit, since: args.since, context: args.context || 0, workspace, chunkType: args.type || null, minConfidence: args.minConfidence != null ? args.minConfidence : null, includeStale: args.includeStale || false });
  if (results.length === 0) {
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
  console.log(`Files indexed: ${stats.fileCount}`);
  console.log(`Total chunks: ${stats.chunkCount}`);
  if (stats.files.length) {
    console.log('\nFiles:');
    for (const f of stats.files) {
      console.log(`  ${f.file_path} (${f.chunk_count} chunks, indexed ${f.indexed_at})`);
    }
  }
} else if (command === 'reflect') {
  const result = runReflectCycle(db, { dryRun: args.dryRun || false });
  const prefix = args.dryRun ? '[DRY RUN] ' : '';
  console.log(`${prefix}Reflect cycle complete:`);
  console.log(`  Decayed: ${result.decay.decayed}`);
  console.log(`  Reinforced: ${result.reinforce.reinforced}`);
  console.log(`  Marked stale: ${result.stale.marked}`);
  console.log(`  Contradictions: ${result.contradictions.newFlags} new (${result.contradictions.found} total)`);
  console.log(`  Archived: ${result.prune.archived}`);
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
  if (args.limit) { sql += ' LIMIT ?'; cParams.push(parseInt(args.limit) || 20); }
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
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

db.close();
