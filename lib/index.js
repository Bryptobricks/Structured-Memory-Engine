#!/usr/bin/env node
const path = require('path');
const { openDb, getStats } = require('./store');
const { indexWorkspace } = require('./indexer');
const { recall } = require('./recall');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) { args.workspace = argv[++i]; }
    else if (argv[i] === '--force') { args.force = true; }
    else if (argv[i] === '--limit' && argv[i + 1]) { args.limit = parseInt(argv[++i]); }
    else if (argv[i] === '--since' && argv[i + 1]) { args.since = argv[++i]; }
    else if (!argv[i].startsWith('-')) { args._.push(argv[i]); }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const workspace = path.resolve(args.workspace || process.cwd());

if (!command || command === 'help') {
  console.log(`Usage:
  node lib/index.js index [--workspace PATH] [--force]
  node lib/index.js query "search terms" [--limit N] [--since 7d|2026-01-01]
  node lib/index.js status [--workspace PATH]`);
  process.exit(0);
}

const db = openDb(workspace);

if (command === 'index') {
  const result = indexWorkspace(db, workspace, { force: args.force });
  console.log(`Indexed ${result.indexed} files, skipped ${result.skipped} unchanged (${result.total} total discovered)`);
} else if (command === 'query') {
  const query = args._.slice(1).join(' ');
  if (!query) { console.error('Usage: node lib/index.js query "search terms"'); process.exit(1); }
  const results = recall(db, query, { limit: args.limit, since: args.since });
  if (results.length === 0) {
    console.log('No results found.');
  } else {
    for (const r of results) {
      console.log(`\n--- ${r.filePath}:${r.lineStart}-${r.lineEnd} ${r.heading ? '(' + r.heading + ')' : ''} [score: ${r.score?.toFixed(4)}]`);
      if (r.entities.length) console.log(`    entities: ${r.entities.join(', ')}`);
      console.log(r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content);
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
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

db.close();
