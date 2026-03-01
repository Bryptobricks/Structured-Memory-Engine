const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  owner: null,
  include: [],
  includeGlobs: [],
  fileTypeDefaults: {},
  fileWeights: {},  // path pattern → weight override, e.g. { "open-loops.md": 1.5 }
  ingest: {
    sourceDir: null,
    autoSync: false,
    entityColumn: null,
  },
  excludeFromRecall: [],
  alwaysExclude: [],
  reflect: {
    decayRate: 1.0,
    halfLifeDays: 365,
    contradictionMinSharedTerms: 3,
    contradictionRequireProximity: false,
    contradictionTemporalAwareness: false,
    autoReflectOnIndex: false,
  },
};

// Confidence values for file-level type defaults (mirrors retain.js TAG_CONFIDENCE)
const TYPE_CONFIDENCE = {
  'fact': 1.0,
  'decision': 1.0,
  'preference': 1.0,
  'confirmed': 1.0,
  'opinion': 0.8,
  'inferred': 0.7,
  'outdated': 0.3,
  'action_item': 0.85,
};

// Normalize type strings (mirrors retain.js TAG_TYPE mapping)
const TYPE_NORMALIZE = {
  'fact': 'fact',
  'decision': 'decision',
  'preference': 'preference',
  'pref': 'preference',
  'confirmed': 'confirmed',
  'opinion': 'opinion',
  'inferred': 'inferred',
  'outdated': 'outdated',
  'outdated?': 'outdated',
  'action_item': 'action_item',
};

function loadConfig(workspace) {
  const configPath = path.join(workspace, '.memory', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULTS, parsed);
  } catch (_) {
    return deepMerge(DEFAULTS, {});
  }
}

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (
      defaults[key] != null &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key]) &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key])
    ) {
      result[key] = { ...defaults[key], ...overrides[key] };
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
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

/**
 * Resolve file-level type default for a relative path.
 * Priority: exact full path > exact basename > glob (longest prefix wins).
 * Returns { type, confidence } or null.
 */
function resolveFileType(relPath, fileTypeDefaults) {
  if (!fileTypeDefaults || typeof fileTypeDefaults !== 'object') return null;

  const basename = path.basename(relPath);

  // 1. Exact match on full relative path
  if (fileTypeDefaults[relPath]) {
    return normalizeType(fileTypeDefaults[relPath]);
  }

  // 2. Exact match on basename
  if (fileTypeDefaults[basename]) {
    return normalizeType(fileTypeDefaults[basename]);
  }

  // 3. Glob pattern match — most specific wins (longest pattern)
  let bestMatch = null;
  let bestLen = -1;
  for (const pattern of Object.keys(fileTypeDefaults)) {
    if (!pattern.includes('*')) continue;
    if (globMatch(pattern, relPath) && pattern.length > bestLen) {
      bestMatch = pattern;
      bestLen = pattern.length;
    }
  }
  if (bestMatch) {
    return normalizeType(fileTypeDefaults[bestMatch]);
  }

  return null;
}

function normalizeType(typeStr) {
  const normalized = TYPE_NORMALIZE[typeStr];
  if (!normalized) return null;
  const confidence = TYPE_CONFIDENCE[normalized];
  if (confidence == null) return null;
  return { type: normalized, confidence };
}

/**
 * Simple glob matcher for file-level type defaults.
 * Supports dir/*.ext and dir/ ** /*.ext patterns.
 */
function globMatch(pattern, filePath) {
  // Convert glob to regex
  const parts = pattern.split('/');
  const fileParts = filePath.split('/');

  let pi = 0, fi = 0;
  while (pi < parts.length && fi < fileParts.length) {
    const pat = parts[pi];
    if (pat === '**') {
      // ** matches zero or more directory segments
      // If it's the last dir segment before the file pattern, consume remaining dirs
      if (pi === parts.length - 2) {
        // Match the file pattern against the last file segment
        return simpleMatch(parts[parts.length - 1], fileParts[fileParts.length - 1]);
      }
      // Try matching ** against 0..N segments
      for (let skip = 0; skip <= fileParts.length - fi; skip++) {
        if (globMatch(parts.slice(pi + 1).join('/'), fileParts.slice(fi + skip).join('/'))) {
          return true;
        }
      }
      return false;
    }
    if (!simpleMatch(pat, fileParts[fi])) return false;
    pi++;
    fi++;
  }
  return pi === parts.length && fi === fileParts.length;
}

function simpleMatch(pattern, str) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === str;
  // *.ext pattern
  const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return regex.test(str);
}

function isExcludedFromRecall(filePath, patterns) {
  if (!patterns || !patterns.length || !filePath) return false;
  for (const pattern of patterns) {
    // Exact match on full path or basename
    if (filePath === pattern || path.basename(filePath) === pattern) return true;
    // Glob match
    if (pattern.includes('*') && globMatch(pattern, filePath)) return true;
  }
  return false;
}

/**
 * Resolve file weight override from config.
 * Checks fileWeights map for exact path, basename, or glob match.
 * Returns the override weight or null if no match.
 */
function resolveFileWeight(filePath, fileWeights) {
  if (!fileWeights || typeof fileWeights !== 'object') return null;
  const basename = path.basename(filePath);

  // Exact match on full path
  if (fileWeights[filePath] != null) return fileWeights[filePath];

  // Exact match on basename
  if (fileWeights[basename] != null) return fileWeights[basename];

  // Glob match — most specific wins
  let bestMatch = null;
  let bestLen = -1;
  for (const pattern of Object.keys(fileWeights)) {
    if (!pattern.includes('*')) continue;
    if (globMatch(pattern, filePath) && pattern.length > bestLen) {
      bestMatch = pattern;
      bestLen = pattern.length;
    }
  }
  if (bestMatch) return fileWeights[bestMatch];

  return null;
}

module.exports = { loadConfig, resolveIncludes, resolveFileType, resolveFileWeight, isExcludedFromRecall, DEFAULTS };
