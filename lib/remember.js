const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_TAGS = new Set(['fact', 'decision', 'pref', 'opinion', 'confirmed', 'inferred', 'action_item']);

// In-memory dedup — keyed by date → Set<hash>
const _dailyHashes = new Map();

function remember(workspace, content, { tag = 'fact', date = null } = {}) {
  if (!VALID_TAGS.has(tag)) {
    throw new Error(`Invalid tag: "${tag}". Must be one of: ${[...VALID_TAGS].join(', ')}`);
  }

  // Sanitize: collapse newlines to spaces, trim
  const sanitized = content.replace(/[\r\n]+/g, ' ').trim();
  if (!sanitized) {
    throw new Error('Content must not be empty');
  }

  const today = date || new Date().toISOString().slice(0, 10);
  const memDir = path.join(workspace, 'memory');
  const filePath = path.join(memDir, `${today}.md`);

  // Dedup: skip if identical content already remembered today
  const hash = crypto.createHash('sha256').update(sanitized).digest('hex').slice(0, 16);
  if (!_dailyHashes.has(today)) _dailyHashes.set(today, new Set());
  if (_dailyHashes.get(today).has(hash)) {
    return { filePath, created: false, line: null, skipped: true };
  }
  _dailyHashes.get(today).add(hash);

  fs.mkdirSync(memDir, { recursive: true });

  // Atomic create-if-not-exists: O_CREAT | O_EXCL fails if file already exists
  let created = false;
  try {
    const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, `# Session Log — ${today}\n\n`);
    fs.closeSync(fd);
    created = true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // File already exists — that's fine, we'll append below
  }

  const line = `- [${tag}] ${sanitized}`;
  fs.appendFileSync(filePath, line + '\n', 'utf-8');

  return { filePath, created, line };
}

function _resetDedupCache() {
  _dailyHashes.clear();
}

module.exports = { remember, VALID_TAGS, _resetDedupCache };
