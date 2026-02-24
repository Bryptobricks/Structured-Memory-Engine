#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, resolveIncludes, DEFAULTS } = require('../lib/config');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function tmpWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-config-test-'));
  fs.mkdirSync(path.join(ws, '.memory'), { recursive: true });
  return ws;
}

// --- Test 1: Returns defaults when no config file exists ---
console.log('Test 1: Returns defaults when no config file exists');
{
  const ws = tmpWorkspace();
  const config = loadConfig(ws);
  assert(config.owner === null, `Expected owner null, got ${config.owner}`);
  assert(Array.isArray(config.include), 'include should be array');
  assert(config.include.length === 0, 'include should be empty');
  assert(Array.isArray(config.includeGlobs), 'includeGlobs should be array');
  assert(config.includeGlobs.length === 0, 'includeGlobs should be empty');
  fs.rmSync(ws, { recursive: true });
}

// --- Test 2: Merges user config over defaults ---
console.log('Test 2: Merges user config over defaults');
{
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, '.memory', 'config.json'), JSON.stringify({
    owner: 'TestUser',
    include: ['CLAUDE.md'],
  }), 'utf-8');
  const config = loadConfig(ws);
  assert(config.owner === 'TestUser', `Expected owner TestUser, got ${config.owner}`);
  assert(config.include.length === 1, `Expected 1 include, got ${config.include.length}`);
  assert(config.include[0] === 'CLAUDE.md', `Expected CLAUDE.md, got ${config.include[0]}`);
  assert(config.includeGlobs.length === 0, 'includeGlobs should default to empty');
  fs.rmSync(ws, { recursive: true });
}

// --- Test 3: Handles malformed JSON gracefully ---
console.log('Test 3: Handles malformed JSON gracefully');
{
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, '.memory', 'config.json'), '{bad json!!!', 'utf-8');
  const config = loadConfig(ws);
  assert(config.owner === null, 'Should fall back to defaults on bad JSON');
  assert(config.include.length === 0, 'Should fall back to empty include');
  fs.rmSync(ws, { recursive: true });
}

// --- Test 4: Resolves explicit file paths ---
console.log('Test 4: Resolves explicit file paths');
{
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Test', 'utf-8');
  fs.writeFileSync(path.join(ws, 'OTHER.md'), '# Other', 'utf-8');
  const config = { ...DEFAULTS, include: ['CLAUDE.md', 'OTHER.md'] };
  const resolved = resolveIncludes(ws, config);
  assert(resolved.length === 2, `Expected 2 files, got ${resolved.length}`);
  assert(resolved[0] === path.join(ws, 'CLAUDE.md'), `Expected CLAUDE.md path, got ${resolved[0]}`);
  fs.rmSync(ws, { recursive: true });
}

// --- Test 5: Resolves dir/*.md glob patterns ---
console.log('Test 5: Resolves dir/*.md glob patterns');
{
  const ws = tmpWorkspace();
  const agentsDir = path.join(ws, 'agents');
  fs.mkdirSync(agentsDir);
  fs.writeFileSync(path.join(agentsDir, 'alpha.md'), '# Alpha', 'utf-8');
  fs.writeFileSync(path.join(agentsDir, 'beta.md'), '# Beta', 'utf-8');
  fs.writeFileSync(path.join(agentsDir, 'notmd.txt'), 'ignored', 'utf-8');
  const config = { ...DEFAULTS, includeGlobs: ['agents/*.md'] };
  const resolved = resolveIncludes(ws, config);
  assert(resolved.length === 2, `Expected 2 .md files, got ${resolved.length}`);
  const names = resolved.map(p => path.basename(p)).sort();
  assert(names[0] === 'alpha.md', `Expected alpha.md, got ${names[0]}`);
  assert(names[1] === 'beta.md', `Expected beta.md, got ${names[1]}`);
  fs.rmSync(ws, { recursive: true });
}

// --- Test 6: Silently skips missing files and directories ---
console.log('Test 6: Silently skips missing files and directories');
{
  const ws = tmpWorkspace();
  const config = { ...DEFAULTS, include: ['nonexistent.md'], includeGlobs: ['missing_dir/*.md'] };
  const resolved = resolveIncludes(ws, config);
  assert(resolved.length === 0, `Expected 0 for missing paths, got ${resolved.length}`);
  fs.rmSync(ws, { recursive: true });
}

// --- Test 7: Deduplicates paths ---
console.log('Test 7: Deduplicates paths');
{
  const ws = tmpWorkspace();
  const agentsDir = path.join(ws, 'agents');
  fs.mkdirSync(agentsDir);
  fs.writeFileSync(path.join(agentsDir, 'agent.md'), '# Agent', 'utf-8');
  // Same file via include and includeGlobs
  const config = { ...DEFAULTS, include: ['agents/agent.md'], includeGlobs: ['agents/*.md'] };
  const resolved = resolveIncludes(ws, config);
  assert(resolved.length === 1, `Expected 1 (deduplicated), got ${resolved.length}`);
  fs.rmSync(ws, { recursive: true });
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
