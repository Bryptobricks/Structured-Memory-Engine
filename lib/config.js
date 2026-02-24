const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  owner: null,
  include: [],
  includeGlobs: [],
};

function loadConfig(workspace) {
  const configPath = path.join(workspace, '.memory', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function resolveIncludes(workspace, config) {
  const seen = new Set();
  const results = [];

  function add(absPath) {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    try {
      if (fs.statSync(absPath).isFile()) results.push(absPath);
    } catch (_) {}
  }

  // Explicit file paths
  for (const rel of config.include || []) {
    add(path.resolve(workspace, rel));
  }

  // Glob patterns — only supports "dir/*.ext" style
  for (const pattern of config.includeGlobs || []) {
    const slashIdx = pattern.lastIndexOf('/');
    if (slashIdx === -1) continue;
    const dir = pattern.slice(0, slashIdx);
    const suffix = pattern.slice(slashIdx + 1);
    // e.g. "*.md" → ext = ".md"
    if (!suffix.startsWith('*')) continue;
    const ext = suffix.slice(1); // e.g. ".md"
    const absDir = path.resolve(workspace, dir);
    try {
      for (const entry of fs.readdirSync(absDir)) {
        if (entry.endsWith(ext)) add(path.join(absDir, entry));
      }
    } catch (_) {}
  }

  return results;
}

module.exports = { loadConfig, resolveIncludes, DEFAULTS };
