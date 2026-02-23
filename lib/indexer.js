const fs = require('fs');
const path = require('path');
const { getFileMeta, insertChunks } = require('./store');

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

  // Split oversized chunks by paragraph
  if (content.length > MAX_CHUNK) {
    const paragraphs = content.split(/\n\n+/);
    let buf = '', bufStart = current.lineStart, lineCount = 0;
    for (const para of paragraphs) {
      if (buf && (buf.length + para.length + 2) > MAX_CHUNK) {
        chunks.push({
          heading: current.heading,
          content: buf.trim(),
          lineStart: bufStart,
          lineEnd: bufStart + lineCount - 1,
          entities: extractEntities(buf)
        });
        buf = '';
        bufStart = bufStart + lineCount;
        lineCount = 0;
      }
      buf += (buf ? '\n\n' : '') + para;
      lineCount += para.split('\n').length + 1;
    }
    if (buf.trim()) {
      chunks.push({
        heading: current.heading,
        content: buf.trim(),
        lineStart: bufStart,
        lineEnd: current.lineStart + current.lines.length - 1,
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

function discoverFiles(workspace) {
  const files = [];
  const memoryMd = path.join(workspace, 'MEMORY.md');
  if (fs.existsSync(memoryMd)) files.push(memoryMd);

  const memDir = path.join(workspace, 'memory');
  if (fs.existsSync(memDir)) {
    for (const f of fs.readdirSync(memDir)) {
      if (f.endsWith('.md')) files.push(path.join(memDir, f));
    }
  }
  return files;
}

function indexWorkspace(db, workspace, { force = false } = {}) {
  const files = discoverFiles(workspace);
  let indexed = 0, skipped = 0;

  for (const filePath of files) {
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
    insertChunks(db, relPath, mtimeMs, chunks, createdAt);
    indexed++;
  }

  return { indexed, skipped, total: files.length };
}

module.exports = { indexWorkspace, chunkMarkdown, extractEntities, discoverFiles };
