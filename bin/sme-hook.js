#!/usr/bin/env node
const path = require('path');
const os = require('os');
const { openDb } = require('../lib/store');
const { indexWorkspace } = require('../lib/indexer');
const { runReflectCycle } = require('../lib/reflect');
const { loadConfig, resolveIncludes } = require('../lib/config');

const workspace = process.env.SME_WORKSPACE || path.join(os.homedir(), '.claude');
const command = process.argv[2];

function log(msg) {
  process.stderr.write(`[sme-hook] ${msg}\n`);
}

if (!command || !['index', 'reflect'].includes(command)) {
  process.stderr.write('Usage: sme-hook.js <index|reflect>\n');
  process.exit(1);
}

const db = openDb(workspace);

try {
  if (command === 'index') {
    const config = loadConfig(workspace);
    const extras = resolveIncludes(workspace, config);
    const include = extras.map(p => path.relative(workspace, p));
    const fileTypeDefaults = config.fileTypeDefaults || {};
    const result = indexWorkspace(db, workspace, { include, fileTypeDefaults });
    log(`Indexed: ${result.indexed} | Skipped: ${result.skipped} | Total: ${result.total} | Cleaned: ${result.cleaned}`);
  } else if (command === 'reflect') {
    const result = runReflectCycle(db);
    log(`Reflect: decayed=${result.decay.decayed} reinforced=${result.reinforce.reinforced} stale=${result.stale.marked} contradictions=${result.contradictions.newFlags} archived=${result.prune.archived}`);
  }
} catch (err) {
  log(`Error: ${err.message}`);
  process.exit(1);
} finally {
  try { db.close(); } catch (_) {}
}
