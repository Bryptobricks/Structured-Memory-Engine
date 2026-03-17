/**
 * compaction-logger.js
 * Hook: session:compact:after
 *
 * After each compaction event, appends a timestamped entry to ~/clawd/memory/LIVE.md.
 * Maintains a rolling window of the last 5 entries.
 * Graceful fallback: any error is logged to stderr; the hook never throws.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_LIVE_PATH = path.join(os.homedir(), 'clawd', 'memory', 'LIVE.md');
const MAX_ENTRIES = 5;

// Delimiter used to separate entries in LIVE.md
const ENTRY_DELIMITER = '\n---\n';

/**
 * Format a compaction stats object into a markdown entry string.
 * @param {Object} stats
 * @param {number} [stats.messagesCompacted]   - number of messages included in compaction
 * @param {number} [stats.tokensBefore]        - token count before compaction
 * @param {number} [stats.tokensAfter]         - token count after compaction
 * @param {number} [stats.summaryLength]       - character length of the generated summary
 * @returns {string}
 */
function formatEntry(stats) {
  const ts = new Date().toISOString();
  const messages = stats.messagesCompacted ?? stats.messages_compacted ?? 'unknown';
  const before   = stats.tokensBefore    ?? stats.tokens_before    ?? 'unknown';
  const after    = stats.tokensAfter     ?? stats.tokens_after     ?? 'unknown';
  const sumLen   = stats.summaryLength   ?? stats.summary_length   ?? 'unknown';

  return [
    `## Compaction — ${ts}`,
    `- Messages compacted: ${messages}`,
    `- Tokens before: ${before}`,
    `- Tokens after:  ${after}`,
    `- Summary length: ${sumLen} chars`,
  ].join('\n');
}

/**
 * Parse LIVE.md content into an array of entry strings.
 * @param {string} content
 * @returns {string[]}
 */
function parseEntries(content) {
  if (!content || !content.trim()) return [];
  // Split on delimiter, filter empties
  return content
    .split(ENTRY_DELIMITER)
    .map(e => e.trim())
    .filter(Boolean);
}

/**
 * Serialize an array of entries back to LIVE.md format.
 * @param {string[]} entries
 * @returns {string}
 */
function serializeEntries(entries) {
  return entries.join(ENTRY_DELIMITER) + '\n';
}

/**
 * Main hook function.
 * @param {Object} stats - compaction stats from the runtime
 * @param {Object} [opts]
 * @param {string} [opts.livePath] - override path for LIVE.md (used in tests)
 */
function compactionLogger(stats, opts = {}) {
  const livePath = opts.livePath || DEFAULT_LIVE_PATH;

  try {
    // Ensure directory exists
    const dir = path.dirname(livePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Read existing entries
    let existing = [];
    if (fs.existsSync(livePath)) {
      const raw = fs.readFileSync(livePath, 'utf8');
      existing = parseEntries(raw);
    }

    // Build new entry
    const newEntry = formatEntry(stats || {});

    // Append and trim to rolling window
    const updated = [...existing, newEntry].slice(-MAX_ENTRIES);

    // Write back
    fs.writeFileSync(livePath, serializeEntries(updated), 'utf8');
  } catch (err) {
    process.stderr.write(`[compaction-logger] Failed to write LIVE.md: ${err.message}\n`);
    // Graceful fallback — never throw
  }
}

module.exports = compactionLogger;
module.exports.compactionLogger = compactionLogger;
module.exports.formatEntry = formatEntry;
module.exports.parseEntries = parseEntries;
module.exports.serializeEntries = serializeEntries;
module.exports.MAX_ENTRIES = MAX_ENTRIES;
module.exports.DEFAULT_LIVE_PATH = DEFAULT_LIVE_PATH;
