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

function walkDir(dir, ext, results) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full, ext, results);
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  } catch (_) {}
  return results;
}

function resolveGlob(workspace, pattern) {
  // Split pattern into segments: "tools/*/reports/*.md" → ["tools", "*", "reports", "*.md"]
  const segments = pattern.split('/');
  const filePattern = segments.pop(); // last segment is the file glob e.g. "*.md"
  if (!filePattern.startsWith('*')) return [];
  const ext = filePattern.slice(1); // e.g. ".md"

  // Resolve directory segments, expanding * and **
  let dirs = [path.resolve(workspace)];
  for (const seg of segments) {
    const next = [];
    for (const d of dirs) {
      if (seg === '**') {
        // Recursive — collect this dir and all subdirs
        next.push(d);
        walkDir(d, '__DIRS_ONLY__', []).length; // not needed, we collect dirs below
        const collectDirs = (dir) => {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                const full = path.join(dir, entry.name);
                next.push(full);
                collectDirs(full);
              }
            }
          } catch (_) {}
        };
        collectDirs(d);
      } else if (seg === '*') {
        // Single-level wildcard — enumerate immediate subdirs
        try {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) next.push(path.join(d, entry.name));
          }
        } catch (_) {}
      } else {
        // Literal directory name
        const full = path.join(d, seg);
        try {
          if (fs.statSync(full).isDirectory()) next.push(full);
        } catch (_) {}
      }
    }
    dirs = next;
  }

  // Collect matching files from resolved dirs
  const files = [];
  for (const d of dirs) {
    try {
      for (const entry of fs.readdirSync(d)) {
        if (entry.endsWith(ext)) files.push(path.join(d, entry));
      }
    } catch (_) {}
  }
  return files;
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

  // Glob patterns — supports dir/*.md, dir/*/sub/*.md, dir/**/*.md
  for (const pattern of config.includeGlobs || []) {
    for (const file of resolveGlob(workspace, pattern)) {
      add(file);
    }
  }

  return results;
}

module.exports = { loadConfig, resolveIncludes, DEFAULTS };
