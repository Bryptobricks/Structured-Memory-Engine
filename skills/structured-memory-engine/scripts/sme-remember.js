#!/usr/bin/env node
'use strict';

const smePath = process.env.SME_PATH;
if (!smePath) {
  console.error('Error: SME_PATH not set. Point it at the Structured-Memory-Engine directory.');
  process.exit(1);
}

const workspace = process.env.SME_WORKSPACE || require('path').join(require('os').homedir(), '.openclaw', 'workspace');
const content = process.argv[2];
const tag = process.argv[3] || 'fact';

if (!content) {
  console.error('Usage: sme-remember.js "content to remember" [tag]');
  console.error('Tags: fact (default), decision, pref, opinion, confirmed, inferred');
  process.exit(1);
}

const sme = require(require('path').join(smePath, 'lib', 'api.js'));
const engine = sme.create({ workspace });

try {
  const result = engine.remember(content, { tag });
  console.log(JSON.stringify({ ok: true, filePath: result.filePath, line: result.line, tag }));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
} finally {
  engine.close();
}
