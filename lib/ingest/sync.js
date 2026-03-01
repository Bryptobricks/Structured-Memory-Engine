'use strict';

const fs = require('fs');
const path = require('path');
const { parseTranscript, generateMarkdown: generateTranscriptMd } = require('./transcripts');
const { parseCsv, generateMarkdown: generateCsvMd } = require('./csv');
const { indexSingleFile } = require('../indexer');

/**
 * Sync a single source file: parse → generate markdown → write → index.
 */
function syncFile(db, workspace, sourcePath, options = {}) {
  const absSource = path.resolve(sourcePath);
  const stat = fs.statSync(absSource);
  const sourceMtime = Math.floor(stat.mtimeMs);
  const stem = path.basename(absSource, path.extname(absSource));
  const ext = path.extname(absSource).toLowerCase();
  const force = options.force || false;
  const fileTypeDefaults = options.fileTypeDefaults || {};

  const ingestDir = path.join(workspace, 'ingest');
  fs.mkdirSync(ingestDir, { recursive: true });

  const manifestPath = path.join(ingestDir, '.sync-manifest.json');
  const manifest = loadManifest(manifestPath);

  const sourceKey = path.basename(absSource);

  // Skip if unchanged (unless force)
  if (!force && manifest.files[sourceKey]) {
    if (manifest.files[sourceKey].sourceMtime === sourceMtime) {
      return { outputPath: manifest.files[sourceKey].outputPath, indexed: false, chunks: 0, skipped: true };
    }
  }

  // Read and parse
  const text = fs.readFileSync(absSource, 'utf-8');
  const type = options.type || detectType(ext);
  let markdown;

  if (type === 'csv') {
    const parsed = parseCsv(text, { entityColumn: options.entityColumn });
    markdown = generateCsvMd(parsed, sourceKey, { entityColumn: options.entityColumn });
  } else {
    // transcript (default)
    const parsed = parseTranscript(text);
    markdown = generateTranscriptMd(parsed, sourceKey);
  }

  // Write markdown
  const outputName = `${stem}.md`;
  const outputPath = path.join(ingestDir, outputName);
  fs.writeFileSync(outputPath, markdown, 'utf-8');

  // Index
  const result = indexSingleFile(db, workspace, outputPath, fileTypeDefaults);

  // Update manifest
  manifest.files[sourceKey] = {
    sourceMtime,
    outputPath: path.relative(workspace, outputPath),
    syncedAt: new Date().toISOString(),
    chunks: 0, // we don't get chunk count from indexSingleFile, but it's metadata
  };
  saveManifest(manifestPath, manifest);

  return {
    outputPath: path.relative(workspace, outputPath),
    indexed: !result.skipped,
    chunks: 0,
    skipped: false,
  };
}

/**
 * Sync all source files in a directory.
 */
function syncAll(db, workspace, sourceDir, options = {}) {
  const absDir = path.resolve(sourceDir);
  const entries = fs.readdirSync(absDir);
  const synced = [];
  const skipped = [];
  const errors = [];

  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!['.txt', '.md', '.csv'].includes(ext)) continue;

    const sourcePath = path.join(absDir, entry);
    try {
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) continue;

      const result = syncFile(db, workspace, sourcePath, options);
      if (result.skipped) {
        skipped.push(entry);
      } else {
        synced.push(entry);
      }
    } catch (err) {
      errors.push({ file: entry, error: err.message });
    }
  }

  return { synced, skipped, errors };
}

function detectType(ext) {
  if (ext === '.csv') return 'csv';
  return 'transcript';
}

function loadManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (_) {
    return { files: {} };
  }
}

function saveManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

module.exports = { syncFile, syncAll };
