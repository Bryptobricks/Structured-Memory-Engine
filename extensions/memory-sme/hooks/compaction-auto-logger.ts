/**
 * Compaction Auto-Logger Hook
 *
 * Fires on `after_compaction` and appends a timestamped entry to
 * memory/LIVE.md in the workspace. Keeps a rolling window of 5 entries.
 *
 * Purpose: Bridges LCM (lossless-claw) with SME. When LCM compacts the
 * conversation context, this hook writes a record to LIVE.md which SME
 * indexes — so the agent has durable memory of "a compaction happened here"
 * across session restarts, without relying on the agent to remember to write it.
 *
 * Event shape (after_compaction):
 *   { messageCount, tokenCount?, compactedCount, sessionFile? }
 *
 * Zero-risk: all errors caught + logged, original behavior preserved.
 *
 * Credit: Hook design by Don (@defi69don / @clawdbotg_bot)
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const ROLLING_MAX = 5;
const SECTION_HEADER = "## Compaction Log";
const ENTRY_SEPARATOR = "\n---\n";

/**
 * Parse existing LIVE.md entries under the compaction section.
 * Returns entries as an array of raw markdown strings.
 */
function parseExistingEntries(content: string): string[] {
  const headerIdx = content.indexOf(SECTION_HEADER);
  if (headerIdx === -1) return [];

  const section = content.slice(headerIdx + SECTION_HEADER.length);
  const entries = section
    .split(ENTRY_SEPARATOR)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return entries;
}

/**
 * Reconstruct LIVE.md with updated compaction entries.
 * Non-compaction content (above the section header) is preserved verbatim.
 */
function rebuildContent(originalContent: string, entries: string[]): string {
  const headerIdx = originalContent.indexOf(SECTION_HEADER);
  const prefix = headerIdx === -1
    ? originalContent.trimEnd() + "\n\n"
    : originalContent.slice(0, headerIdx);

  const body = entries.join(ENTRY_SEPARATOR);
  return `${prefix}${SECTION_HEADER}\n\n${body}\n`;
}

/**
 * Format a single compaction log entry in markdown.
 */
function formatEntry(event: {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  summaryLength?: number;
  tokensBefore?: number;
  tokensAfter?: number;
}): string {
  const ts = new Date().toISOString();
  const lines: string[] = [
    `### Compaction — ${ts}`,
    `- **Messages after:** ${event.messageCount}`,
    `- **Compacted:** ${event.compactedCount} messages removed`,
  ];

  if (event.tokensBefore !== undefined && event.tokensAfter !== undefined) {
    const saved = event.tokensBefore - event.tokensAfter;
    const pct = event.tokensBefore > 0
      ? Math.round((saved / event.tokensBefore) * 100)
      : 0;
    lines.push(`- **Tokens:** ${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} (saved ${saved.toLocaleString()}, ${pct}%)`);
  } else if (event.tokenCount !== undefined) {
    lines.push(`- **Tokens after:** ${event.tokenCount.toLocaleString()}`);
  }

  if (event.summaryLength !== undefined) {
    lines.push(`- **Summary length:** ${event.summaryLength.toLocaleString()} chars`);
  }

  return lines.join("\n");
}

/**
 * Register the compaction auto-logger hook with the OpenClaw plugin API.
 *
 * @param api - OpenClaw plugin API
 * @param workspace - Path to the agent workspace (where memory/ lives)
 */
export function registerCompactionAutoLogger(api: any, workspace: string): void {
  const liveMdPath = resolve(workspace, "memory", "LIVE.md");
  const memoryDir = dirname(liveMdPath);

  api.on(
    "after_compaction",
    async (event: {
      messageCount: number;
      tokenCount?: number;
      compactedCount: number;
      summaryLength?: number;
      tokensBefore?: number;
      tokensAfter?: number;
      sessionFile?: string;
    }) => {
      try {
        // Ensure memory/ directory exists
        if (!existsSync(memoryDir)) {
          mkdirSync(memoryDir, { recursive: true });
        }

        const entry = formatEntry(event);

        // Read + parse existing content
        let existingContent = "";
        if (existsSync(liveMdPath)) {
          existingContent = readFileSync(liveMdPath, "utf-8");
        } else {
          // Bootstrap the file with a header
          existingContent = `# LIVE.md — Live Session State\n\nAuto-maintained by Clawd. Do not edit manually.\n\n`;
        }

        const entries = parseExistingEntries(existingContent);

        // Prepend new entry, enforce rolling max
        const updated = [entry, ...entries].slice(0, ROLLING_MAX);

        const newContent = rebuildContent(existingContent, updated);
        writeFileSync(liveMdPath, newContent, "utf-8");

        api.logger?.info?.(
          `memory-sme: compaction logged to LIVE.md (${event.compactedCount} compacted, ${updated.length}/${ROLLING_MAX} entries)`
        );
      } catch (err: any) {
        // Zero-risk: log and swallow — compaction must never fail because of us
        api.logger?.warn?.(
          `memory-sme: compaction-auto-logger failed (non-fatal): ${String(err)}`
        );
      }
    },
    { priority: 0 }
  );

  api.logger?.debug?.(`memory-sme: compaction-auto-logger registered (target: ${liveMdPath})`);
}
