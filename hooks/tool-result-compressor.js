/**
 * tool-result-compressor.js
 * Hook: tool_result_persist
 *
 * Strips noise from tool results before they persist to the transcript:
 *   - ANSI escape sequences
 *   - npm WARN / notice lines
 *   - pip WARNING / deprecation lines
 *   - Node.js ExperimentalWarning lines
 *   - Box-drawing characters
 *   - Excessive blank lines (3+ consecutive → 2)
 * Truncates at 8192 chars with a marker.
 *
 * Handles both string content and array-of-parts ({type, text}) format.
 * Returns { message } with cleaned content only when changes were made.
 * Returns null/undefined (no-op) when nothing changed.
 * Graceful fallback: returns undefined on any error.
 */

const MAX_LENGTH = 8192;

// ANSI escape sequences: CSI sequences and other escape codes
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDEFsu]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g;

// npm WARN / notice lines (whole line)
const NPM_WARN_RE = /^npm (WARN|notice).*$/gm;

// pip WARNING and deprecation lines
const PIP_WARN_RE = /^(WARNING: |DEPRECATION: ).*$/gm;

// Node.js ExperimentalWarning
const NODE_EXPERIMENTAL_RE = /^\(node:\d+\) \[?ExperimentalWarning.*$/gm;

// Box-drawing characters (common Unicode box-drawing block U+2500–U+257F + curved variants)
const BOX_DRAWING_RE = /[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿]/g;

// 3+ consecutive blank lines → 2
const EXCESS_BLANK_RE = /\n{3,}/g;

/**
 * Clean a single string of tool output.
 * @param {string} text
 * @returns {{ cleaned: string, changed: boolean }}
 */
function cleanText(text) {
  if (typeof text !== 'string') return { cleaned: text, changed: false };

  let out = text;

  out = out.replace(ANSI_RE, '');
  out = out.replace(NPM_WARN_RE, '');
  out = out.replace(PIP_WARN_RE, '');
  out = out.replace(NODE_EXPERIMENTAL_RE, '');
  out = out.replace(BOX_DRAWING_RE, '');
  out = out.replace(EXCESS_BLANK_RE, '\n\n');

  // Truncate
  if (out.length > MAX_LENGTH) {
    const excess = out.length - MAX_LENGTH;
    out = out.slice(0, MAX_LENGTH) + `\n[...truncated ${excess} chars...]`;
  }

  const changed = out !== text;
  return { cleaned: out, changed };
}

/**
 * Main hook function.
 *
 * @param {Object|string|Array} message
 *   - string: plain text content
 *   - Array: array of {type, text} parts (OpenAI tool_result format)
 *   - Object with .content: same as above
 * @returns {{ message: Object|string|Array }|null|undefined}
 */
function toolResultCompressor(message) {
  try {
    // Normalize: extract content
    let content = message;
    let isWrapped = false;

    if (message && typeof message === 'object' && !Array.isArray(message) && 'content' in message) {
      content = message.content;
      isWrapped = true;
    }

    let changed = false;
    let result;

    if (typeof content === 'string') {
      const { cleaned, changed: c } = cleanText(content);
      changed = c;
      result = cleaned;
    } else if (Array.isArray(content)) {
      const newParts = content.map(part => {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          const { cleaned, changed: c } = cleanText(part.text);
          if (c) changed = true;
          return c ? { ...part, text: cleaned } : part;
        }
        return part;
      });
      result = changed ? newParts : content;
    } else {
      // Unsupported type — no-op
      return undefined;
    }

    if (!changed) return null;

    if (isWrapped) {
      return { message: { ...message, content: result } };
    }
    return { message: result };
  } catch (err) {
    process.stderr.write(`[tool-result-compressor] Error: ${err.message}\n`);
    return undefined;
  }
}

module.exports = toolResultCompressor;
module.exports.toolResultCompressor = toolResultCompressor;
module.exports.cleanText = cleanText;
module.exports.MAX_LENGTH = MAX_LENGTH;
