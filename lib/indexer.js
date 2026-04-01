const fs = require('fs');
const path = require('path');
const { getFileMeta, insertChunks, getAllFilePaths, deleteFileChunks } = require('./store');
const { extractFacts } = require('./retain');
const { resolveFileType, isExcludedFromRecall } = require('./config');
const { classifyPriority } = require('./value-scoring');
const { extractReferencedDate } = require('./temporal');

const MAX_CHUNK = 2000;

const DECISION_SIGNAL_RE = /\b(decided|chose|going with|committed to|plan to|will use|let'?s go with|we'?re doing|approved|killed|cancelled|stick with|moving to|switched to)\b/gi;
const PREFERENCE_SIGNAL_RE = /\b(prefers?|likes?|loves?|hates?|dislikes?|always uses?|favorite)\b/i;

function classifySourceType(filePath) {
  if (filePath.startsWith('memory/') || filePath.startsWith('memory\\')) return 'manual';
  if (filePath.startsWith('ingest/') || filePath.startsWith('ingest\\')) return 'ingested';
  return 'indexed';
}

const DOMAIN_KEYWORDS = {
  health: /\b(dose|mg|prescription|supplement|medication|blood|lab|doctor|testosterone|creatinine|vitamin|workout|exercise|sleep|diagnosis|allergic)\b/gi,
  crypto: /\b(wallet|token|swap|yield|portfolio|position|protocol|chain|defi|staking|airdrop|dex|eth|btc|solana|liquidity)\b/gi,
  work: /\b(meeting|standup|sprint|deploy|PR|ticket|team|project|milestone|deadline|roadmap|OKR|retro)\b/gi,
  finance: /\b(insurance|subscription|bank|payment|cost|budget|invoice|tax|salary|income|mortgage|rent)\b/gi,
};

function classifyDomain(content, filePath, domainLabels) {
  // Config path patterns take priority
  if (domainLabels && typeof domainLabels === 'object') {
    for (const [domain, patterns] of Object.entries(domainLabels)) {
      if (!Array.isArray(patterns)) continue;
      for (const p of patterns) {
        if (filePath.startsWith(p) || filePath.includes(p)) return domain;
      }
    }
  }
  // Keyword matching — need 2+ matches to classify
  let best = null, bestCount = 0;
  for (const [domain, re] of Object.entries(DOMAIN_KEYWORDS)) {
    const matches = (content.match(re) || []).length;
    if (matches >= 2 && matches > bestCount) {
      best = domain;
      bestCount = matches;
    }
  }
  return best || 'general';
}

/**
 * Classify a chunk by explicit tags in its content.
 * Returns a chunk_type string or null if no tag found.
 * Only matches explicit [tag] markers — no content heuristics.
 */
function classifyChunk(content) {
  const text = content.toLowerCase();
  if (/\[confirmed\]/.test(text)) return 'confirmed';
  if (/\[fact\]/.test(text)) return 'fact';
  if (/\[decision\]/.test(text)) return 'decision';
  if (/\[preference\]|\[pref\]/.test(text)) return 'preference';
  if (/\[opinion\]/.test(text)) return 'opinion';
  if (/\[inferred\]/.test(text)) return 'inferred';
  if (/\[action_item\]/.test(text)) return 'action_item';
  if (/\[outdated\?\]/.test(text)) return 'outdated';
  if (/\[system\]/.test(text)) return 'fact';
  // Heuristic detection (no explicit tag found)
  const decisionMatches = (content.match(DECISION_SIGNAL_RE) || []).length;
  if (decisionMatches >= 2) return { type: 'decision', confidence: 0.7 };
  if (PREFERENCE_SIGNAL_RE.test(content)) return { type: 'preference', confidence: 0.7 };
  return null;
}

function extractEntities(text) {
  const entities = new Set();
  // @mentions
  for (const m of text.matchAll(/@(\w+)/g)) entities.add('@' + m[1]);
  // **bold terms**
  for (const m of text.matchAll(/\*\*([^*]+)\*\*/g)) entities.add(m[1]);
  // Acronyms (2+ uppercase letters, not inside words)
  for (const m of text.matchAll(/\b([A-Z]{2,})\b/g)) {
    // Skip common non-entity uppercase words
    if (!ACRONYM_SKIP.has(m[1])) entities.add(m[1]);
  }
  // Tickers ($BTC, $ETH)
  for (const m of text.matchAll(/\$([A-Z]{2,6})\b/g)) entities.add('$' + m[1]);
  // "Quoted terms" (3-50 chars)
  for (const m of text.matchAll(/"([^"]{3,50})"/g)) entities.add(m[1]);
  // URLs
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) entities.add(m[0]);
  return [...entities];
}

const ACRONYM_SKIP = new Set([
  'OK', 'AM', 'PM', 'US', 'OR', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO',
  'GO', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'ON', 'SO',
  'TO', 'UP', 'WE', 'ID', 'VS', 'MD', 'IE', 'EG',
]);

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

// Speaker turn pattern: "Name:", "Speaker Name:", "[00:00:00] Name:", etc.
const SPEAKER_TURN = /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?[A-Z][A-Za-z\s]{0,30}:/m;

/**
 * Split oversized text by speaker turns (for transcripts) or sentence boundaries (last resort).
 */
function splitOversized(text, heading, lineStart, maxLineEnd, chunks) {
  // Try speaker-turn splitting first
  const turns = text.split(SPEAKER_TURN);
  const turnMatches = [...text.matchAll(new RegExp(SPEAKER_TURN.source, 'gm'))];
  if (turnMatches.length >= 2) {
    let buf = turns[0] || '';
    let bufStart = lineStart;
    let cumLines = buf.split('\n').length;
    for (let i = 0; i < turnMatches.length; i++) {
      const turnContent = (turnMatches[i][0] || '') + (turns[i + 1] || '');
      const turnLines = turnContent.split('\n').length;
      if (buf && (buf.length + turnContent.length + 1) > MAX_CHUNK) {
        if (buf.trim()) {
          const lineEnd = Math.min(bufStart + cumLines - 1, maxLineEnd);
          chunks.push({ heading, content: buf.trim(), lineStart: bufStart, lineEnd, entities: extractEntities(buf) });
          bufStart = lineEnd + 1;
        }
        buf = '';
        cumLines = 0;
      }
      buf += (buf ? '\n' : '') + turnContent;
      cumLines += turnLines;
    }
    if (buf.trim()) {
      chunks.push({ heading, content: buf.trim(), lineStart: bufStart, lineEnd: maxLineEnd, entities: extractEntities(buf) });
    }
    return;
  }

  // Last resort: hard split on sentence boundaries
  const sentences = text.split(/(?<=[.!?])\s+/);
  let buf = '', bufStart = lineStart, cumLines = 0;
  for (const sentence of sentences) {
    const sLines = sentence.split('\n').length;
    if (buf && (buf.length + sentence.length + 1) > MAX_CHUNK) {
      if (buf.trim()) {
        const lineEnd = Math.min(bufStart + cumLines - 1, maxLineEnd);
        chunks.push({ heading, content: buf.trim(), lineStart: bufStart, lineEnd, entities: extractEntities(buf) });
        bufStart = lineEnd + 1;
      }
      buf = '';
      cumLines = 0;
    }
    buf += (buf ? ' ' : '') + sentence;
    cumLines += sLines;
  }
  if (buf.trim()) {
    chunks.push({ heading, content: buf.trim(), lineStart: bufStart, lineEnd: maxLineEnd, entities: extractEntities(buf) });
  }
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
        // If paragraph-split buffer is still oversized, use deeper splitting
        if (buf.trim().length > MAX_CHUNK) {
          const lineEnd = Math.min(bufStart + cumLines - 1, maxLineEnd);
          splitOversized(buf.trim(), current.heading, bufStart, lineEnd, chunks);
        } else {
          const lineEnd = Math.min(bufStart + cumLines - 1, maxLineEnd);
          chunks.push({
            heading: current.heading,
            content: buf.trim(),
            lineStart: bufStart,
            lineEnd,
            entities: extractEntities(buf)
          });
        }
        buf = '';
        bufStart = Math.min(bufStart + cumLines, maxLineEnd);
        cumLines = 0;
      }
      buf += (buf ? '\n\n' : '') + para;
      cumLines += paraLines + (cumLines > 0 ? 1 : 0);
    }
    if (buf.trim()) {
      // Final buffer may also be oversized
      if (buf.trim().length > MAX_CHUNK) {
        splitOversized(buf.trim(), current.heading, bufStart, maxLineEnd, chunks);
      } else {
        chunks.push({
          heading: current.heading,
          content: buf.trim(),
          lineStart: bufStart,
          lineEnd: maxLineEnd,
          entities: extractEntities(buf)
        });
      }
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

function indexWorkspace(db, workspace, { force = false, include = [], fileTypeDefaults = {}, excludePatterns = [], domainLabels = {} } = {}) {
  const files = discoverFiles(workspace, { include });
  let indexed = 0, skipped = 0, excluded = 0;

  const errors = [];
  for (const filePath of files) {
    const relPath = path.relative(workspace, filePath);
    if (excludePatterns.length > 0 && isExcludedFromRecall(relPath, excludePatterns)) {
      excluded++;
      continue;
    }
    try {
      const stat = fs.statSync(filePath);
      const mtimeMs = Math.floor(stat.mtimeMs);

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

      // v7.1: Auto-classify remaining raw chunks by explicit tags or heuristics
      for (const chunk of chunks) {
        if (!chunk.chunkType || chunk.chunkType === 'raw') {
          const classified = classifyChunk(chunk.content);
          if (classified) {
            if (typeof classified === 'string') {
              chunk.chunkType = classified;
            } else {
              chunk.chunkType = classified.type;
              if (!chunk.confidence || classified.confidence < chunk.confidence) {
                chunk.confidence = classified.confidence;
              }
            }
          }
        }
      }

      // v8.1: Domain classification
      for (const chunk of chunks) {
        chunk.domain = classifyDomain(chunk.content, relPath, domainLabels);
      }

      // v9: Priority classification
      for (const chunk of chunks) {
        chunk.priority = classifyPriority({ content: chunk.content, chunk_type: chunk.chunkType || 'raw', confidence: chunk.confidence });
      }

      // v9: Referenced date extraction (three-date temporal model)
      const refNow = createdAt ? new Date(createdAt) : new Date();
      for (const chunk of chunks) {
        const { referencedDate, relativeOffset } = extractReferencedDate(chunk.content, refNow);
        chunk.referencedDate = referencedDate;
        chunk.relativeOffset = relativeOffset;
      }

      const sourceType = classifySourceType(relPath);
      insertChunks(db, relPath, mtimeMs, chunks, createdAt, undefined, sourceType);
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

  return { indexed, skipped, excluded, errors, total: files.length, cleaned };
}

/**
 * indexSingleFile — index (or skip) a single file. Shared implementation used by
 * MCP server, programmatic API, and hook.
 */
function indexSingleFile(db, workspace, filePath, fileTypeDefaults, excludePatterns, domainLabels) {
  const stat = fs.statSync(filePath);
  const mtimeMs = Math.floor(stat.mtimeMs);
  const relPath = path.relative(workspace, filePath);

  if (excludePatterns && excludePatterns.length > 0 && isExcludedFromRecall(relPath, excludePatterns)) {
    return { skipped: true, excluded: true };
  }

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

  // v7.1: Auto-classify remaining raw chunks by explicit tags or heuristics
  for (const chunk of chunks) {
    if (!chunk.chunkType || chunk.chunkType === 'raw') {
      const classified = classifyChunk(chunk.content);
      if (classified) {
        if (typeof classified === 'string') {
          chunk.chunkType = classified;
        } else {
          chunk.chunkType = classified.type;
          if (!chunk.confidence || classified.confidence < chunk.confidence) {
            chunk.confidence = classified.confidence;
          }
        }
      }
    }
  }

  // v8.1: Domain classification
  for (const chunk of chunks) {
    chunk.domain = classifyDomain(chunk.content, relPath, domainLabels);
  }

  // v9: Priority classification
  for (const chunk of chunks) {
    chunk.priority = classifyPriority({ content: chunk.content, chunk_type: chunk.chunkType || 'raw', confidence: chunk.confidence });
  }

  // v9: Referenced date extraction (three-date temporal model)
  const refNow = createdAt ? new Date(createdAt) : new Date();
  for (const chunk of chunks) {
    const { referencedDate, relativeOffset } = extractReferencedDate(chunk.content, refNow);
    chunk.referencedDate = referencedDate;
    chunk.relativeOffset = relativeOffset;
  }

  const sourceType = classifySourceType(relPath);
  insertChunks(db, relPath, mtimeMs, chunks, createdAt, undefined, sourceType);
  return { skipped: false };
}

module.exports = { indexWorkspace, indexSingleFile, chunkMarkdown, extractEntities, discoverFiles, classifyChunk, classifySourceType, classifyDomain };
