const fs = require('fs');
const path = require('path');
const { getFileMeta, insertChunks, getAllFilePaths, deleteFileChunks } = require('./store');
const { extractFacts } = require('./retain');
const { resolveFileType } = require('./config');

const MAX_CHUNK = 2000;

function extractEntities(text) {
  const entities = new Set();
  // @mentions
  for (const m of text.matchAll(/@(\w+)/g)) entities.add('@' + m[1]);
  // **bold terms**
  for (const m of text.matchAll(/\*\*([^*]+)\*\*/g)) entities.add(m[1]);
  return [...entities];
}

function extractDateFromPath(filePath) {
  const m = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] + 'T00:00:00.000Z' : null;
}

function chunkMarkdown(text) {
  const lines = text.split('\n');
  const chunks = [];
  let current = { heading: null, lines: [], lineStart: 1 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);

    if (headingMatch && current.lines.length > 0) {
      // flush
      pushChunk(chunks, current);
      current = { heading: headingMatch[2].trim(), lines: [], lineStart: i + 1 };
    } else if (headingMatch && current.lines.length === 0) {
      current.heading = headingMatch[2].trim();
      current.lineStart = i + 1;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) pushChunk(chunks, current);
  return chunks;
}

function pushChunk(chunks, current) {
  const content = current.lines.join('\n').trim();
  if (!content) return;

  // Skip heading-only chunks with no substantive content
  const stripped = content.replace(/^#{1,6}\s+.*$/gm, '').trim();
  if (stripped.length < 5) return;

  // Split oversized chunks by paragraph
  if (content.length > MAX_CHUNK) {
    const maxLineEnd = current.lineStart + current.lines.length - 1;
    const paragraphs = content.split(/\n\n+/);
    let buf = '', bufStart = current.lineStart, cumLines = 0;
    for (const para of paragraphs) {
      const paraLines = para.split('\n').length;
      if (buf && (buf.length + para.length + 2) > MAX_CHUNK) {
        const lineEnd = Math.min(bufStart + cumLines - 1, maxLineEnd);
        chunks.push({
          heading: current.heading,
          content: buf.trim(),
          lineStart: bufStart,
          lineEnd,
          entities: extractEntities(buf)
        });
        buf = '';
        bufStart = lineEnd + 1;
        cumLines = 0;
      }
      buf += (buf ? '\n\n' : '') + para;
      cumLines += paraLines + (cumLines > 0 ? 1 : 0); // +1 for blank line between paragraphs
    }
    if (buf.trim()) {
      chunks.push({
        heading: current.heading,
        content: buf.trim(),
        lineStart: bufStart,
        lineEnd: maxLineEnd,
        entities: extractEntities(buf)
      });
    }
  } else {
    chunks.push({
      heading: current.heading,
      content,
      lineStart: current.lineStart,
      lineEnd: current.lineStart + current.lines.length - 1,
      entities: extractEntities(content)
    });
  }
}

function discoverFiles(workspace, { include = [] } = {}) {
  const files = [];
  const defaultFiles = ['MEMORY.md', 'SOUL.md', 'USER.md', 'STATE.md', 'TOOLS.md', 'VOICE.md', 'IDENTITY.md'];
  for (const name of defaultFiles) {
    const p = path.join(workspace, name);
    if (fs.existsSync(p)) files.push(p);
  }

  const memDir = path.join(workspace, 'memory');
  if (fs.existsSync(memDir)) {
    for (const f of fs.readdirSync(memDir)) {
      if (f.endsWith('.md')) files.push(path.join(memDir, f));
    }
  }

  // Ingest directory — markdown generated from external sources
  const ingestDir = path.join(workspace, 'ingest');
  if (fs.existsSync(ingestDir)) {
    for (const f of fs.readdirSync(ingestDir)) {
      if (f.endsWith('.md')) files.push(path.join(ingestDir, f));
    }
  }

  // Additional include patterns/paths
  for (const pattern of include) {
    const p = path.resolve(workspace, pattern);
    if (fs.existsSync(p) && fs.statSync(p).isFile() && !files.includes(p)) {
      files.push(p);
    }
  }
  return files;
}

function indexWorkspace(db, workspace, { force = false, include = [], fileTypeDefaults = {} } = {}) {
  const files = discoverFiles(workspace, { include });
  let indexed = 0, skipped = 0;

  const errors = [];
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      const mtimeMs = Math.floor(stat.mtimeMs);
      const relPath = path.relative(workspace, filePath);

      if (!force) {
        const meta = getFileMeta(db, relPath);
        if (meta && meta.mtime_ms === mtimeMs) { skipped++; continue; }
      }

      const text = fs.readFileSync(filePath, 'utf-8');
      const chunks = chunkMarkdown(text);
      const createdAt = extractDateFromPath(filePath);

      // v4.2: Apply file-level type defaults (config overrides raw, inline tags override config)
      const fileDefault = resolveFileType(relPath, fileTypeDefaults);
      if (fileDefault) {
        for (const chunk of chunks) {
          chunk.chunkType = fileDefault.type;
          chunk.confidence = fileDefault.confidence;
        }
      }

      // v2 Retain: extract structured facts and upgrade matching chunks
      // Facts upgrade their parent chunk's type/confidence — no standalone duplicates
      const facts = extractFacts(text, relPath);
      if (facts.length > 0) {
        for (const chunk of chunks) {
          // Find the best (highest confidence) fact within this chunk's line range
          let bestFact = null;
          for (const f of facts) {
            if (f.lineStart >= chunk.lineStart && f.lineStart <= chunk.lineEnd) {
              if (!bestFact || f.confidence > bestFact.confidence) bestFact = f;
            }
          }
          if (bestFact) {
            chunk.chunkType = bestFact.type;
            chunk.confidence = bestFact.confidence;
          }
        }
      }

      insertChunks(db, relPath, mtimeMs, chunks, createdAt);
      indexed++;
    } catch (err) {
      errors.push({ file: filePath, error: err.message });
    }
  }

  // Orphan cleanup: remove DB entries for files no longer on disk
  let cleaned = 0;
  const discoveredRelPaths = new Set(files.map(f => path.relative(workspace, f)));
  for (const dbPath of getAllFilePaths(db)) {
    if (!discoveredRelPaths.has(dbPath)) {
      deleteFileChunks(db, dbPath);
      cleaned++;
    }
  }

  return { indexed, skipped, errors, total: files.length, cleaned };
}

/**
 * indexSingleFile — index (or skip) a single file. Shared implementation used by
 * MCP server, programmatic API, and hook.
 */
function indexSingleFile(db, workspace, filePath, fileTypeDefaults) {
  const stat = fs.statSync(filePath);
  const mtimeMs = Math.floor(stat.mtimeMs);
  const relPath = path.relative(workspace, filePath);

  const meta = getFileMeta(db, relPath);
  if (meta && meta.mtime_ms === mtimeMs) return { skipped: true };

  const text = fs.readFileSync(filePath, 'utf-8');
  const chunks = chunkMarkdown(text);
  const createdAt = extractDateFromPath(filePath);

  const fileDefault = resolveFileType(relPath, fileTypeDefaults || {});
  if (fileDefault) {
    for (const chunk of chunks) {
      chunk.chunkType = fileDefault.type;
      chunk.confidence = fileDefault.confidence;
    }
  }

  const facts = extractFacts(text, relPath);
  if (facts.length > 0) {
    for (const chunk of chunks) {
      let bestFact = null;
      for (const f of facts) {
        if (f.lineStart >= chunk.lineStart && f.lineStart <= chunk.lineEnd) {
          if (!bestFact || f.confidence > bestFact.confidence) bestFact = f;
        }
      }
      if (bestFact) {
        chunk.chunkType = bestFact.type;
        chunk.confidence = bestFact.confidence;
      }
    }
  }

  insertChunks(db, relPath, mtimeMs, chunks, createdAt);
  return { skipped: false };
}

module.exports = { indexWorkspace, indexSingleFile, chunkMarkdown, extractEntities, discoverFiles };
