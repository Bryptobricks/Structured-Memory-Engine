/**
 * Tool Result Compressor Hook
 *
 * Fires synchronously on `tool_result_persist` — before each tool result
 * is written to the session transcript. Strips noise and truncates large
 * results to reduce context waste.
 *
 * What it strips:
 *   - ANSI escape sequences (color codes, cursor movements)
 *   - npm/pip/node/yarn warning lines
 *   - Box-drawing characters (─ │ ╭ ╮ ╰ ╯ ┌ ┐ └ ┘ etc.)
 *   - Excessive blank lines (3+ collapsed to 2)
 *
 * What it truncates:
 *   - Results >8K chars: trimmed with a clear "[Truncated: X chars removed]" marker
 *   - Only text content blocks are modified; image blocks are passed through
 *
 * Zero-risk: if ANY error occurs, original message is returned unchanged.
 * This hook is synchronous (as required by OpenClaw's tool_result_persist contract).
 *
 * Credit: Hook design by Don (@defi69don / @clawdbotg_bot)
 */

const MAX_CHARS = 8_000;

// ANSI escape sequences: ESC [ ... m and variants
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;

// Box-drawing unicode block (U+2500–U+257F) plus common extended variants
const BOX_DRAWING_RE = /[\u2500-\u257F\u2580-\u259F]+/g;

// npm/pip/node/yarn warning lines — full lines starting with these prefixes
// Also strips npm ERR! lines that are just noise (like resolution errors repeated 50x)
const NOISE_LINE_RE = /^(npm warn|npm notice|npm ERR!|warning:|yarn warning:|node:.*deprecat|\(node:\d+\)|pip.*warning:|deprecation warning:).*/gim;

// Three or more consecutive blank lines → two blank lines
const EXCESSIVE_BLANK_RE = /\n{3,}/g;

/**
 * Clean a single text string.
 * Returns { cleaned, charsRemoved }.
 */
function cleanText(text: string): { cleaned: string; charsRemoved: number } {
  const original = text;

  let cleaned = text
    .replace(ANSI_RE, "")
    .replace(BOX_DRAWING_RE, "")
    .replace(NOISE_LINE_RE, "")
    .replace(EXCESSIVE_BLANK_RE, "\n\n")
    .trimEnd();

  // Truncate if still over limit
  if (cleaned.length > MAX_CHARS) {
    const removed = cleaned.length - MAX_CHARS;
    cleaned =
      cleaned.slice(0, MAX_CHARS) +
      `\n\n[Truncated: ${removed.toLocaleString()} chars removed]`;
  }

  return {
    cleaned,
    charsRemoved: original.length - cleaned.length,
  };
}

/**
 * Register the tool result compressor hook with the OpenClaw plugin API.
 *
 * Must be synchronous — tool_result_persist is a hot-path sync hook.
 */
export function registerToolResultCompressor(api: any): void {
  api.on(
    "tool_result_persist",
    (event: {
      toolName?: string;
      toolCallId?: string;
      message: any; // AgentMessage / ToolResultMessage
      isSynthetic?: boolean;
    }) => {
      try {
        const msg = event.message;
        if (!msg || msg.role !== "toolResult") return; // passthrough non-tool messages

        const content = msg.content;
        if (!Array.isArray(content) || content.length === 0) return;

        let totalCharsRemoved = 0;
        let modified = false;

        const newContent = content.map((block: any) => {
          // Only process text blocks; pass images and other types through
          if (!block || block.type !== "text" || typeof block.text !== "string") {
            return block;
          }

          const { cleaned, charsRemoved } = cleanText(block.text);

          if (charsRemoved !== 0) {
            modified = true;
            totalCharsRemoved += charsRemoved;
            return { ...block, text: cleaned };
          }

          return block;
        });

        if (!modified) return; // no changes — return undefined to skip replacement

        api.logger?.debug?.(
          `memory-sme: tool-result-compressor compressed "${event.toolName ?? "unknown"}" result by ${totalCharsRemoved.toLocaleString()} chars`
        );

        return { message: { ...msg, content: newContent } };
      } catch (err: any) {
        // Zero-risk: any failure → return undefined (original message persists)
        api.logger?.warn?.(
          `memory-sme: tool-result-compressor failed (non-fatal): ${String(err)}`
        );
        return;
      }
    },
    { priority: 5 } // run before other persist hooks
  );

  api.logger?.debug?.("memory-sme: tool-result-compressor registered");
}
