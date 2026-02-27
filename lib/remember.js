const fs = require('fs');
const path = require('path');

const VALID_TAGS = new Set(['fact', 'decision', 'pref', 'opinion', 'confirmed', 'inferred', 'action_item']);

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

module.exports = { remember, VALID_TAGS };
