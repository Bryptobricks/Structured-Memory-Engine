/**
 * OpenClaw Memory (SME) Plugin
 *
 * Structured Memory Engine — FTS5 full-text search with confidence scoring,
 * entity graph, contradiction detection, and memory lifecycle management.
 * Zero API calls, fully offline, self-maintaining.
 */

import { Type } from "@sinclair/typebox";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { resolve } from "path";

const require = createRequire(import.meta.url);

// Patterns that indicate content worth capturing automatically
const CAPTURE_TRIGGERS = [
  /\b(decided|decision|choosing|chose|picked|going with|settled on)\b/i,
  /\b(prefer|preference|always use|never use|switched to|moving to)\b/i,
  /\b(remember|don't forget|note to self|important:|key takeaway)\b/i,
  /\b(learned|realized|discovered|turns out|found out)\b/i,
  /\b(started|stopped|quit|dropped|added|removed|changed)\b.{5,}\b(daily|weekly|routine|protocol|stack|dose)\b/i,
  /\b(agreed|committed|promised|scheduled|deadline)\b/i,
];

/**
 * Strip conversation metadata injected by Telegram/OpenClaw before evaluation.
 * Removes "Conversation info (untrusted metadata): ```json ... ```" blocks.
 */
function stripConversationMeta(text: string): string {
  return text
    .replace(/Conversation info\s*\(untrusted metadata\)\s*:\s*```[\s\S]*?```\s*/gi, "")
    .trim();
}

function shouldCapture(text: string): string | null {
  if (!text || text.length < 20) return null;
  // Skip system messages, cron heartbeats, media metadata, recalled context blocks
  if (/^\s*System:\s*\[/i.test(text)) return null;
  if (/HEARTBEAT_OK/i.test(text)) return null;
  if (/^\s*\[media attached/i.test(text)) return null;
  if (/^\s*## Recalled Context/i.test(text)) return null;
  if (/Cron:|scheduled reminder|handle this reminder/i.test(text)) return null;
  if (/inbound\/file_\d+---/i.test(text)) return null;
  if (/To send an image back/i.test(text)) return null;

  // Bug 5: Skip code blocks, CLI output, git hashes
  if ((text.match(/```/g) || []).length >= 2) return null;
  if (/^\s*[\$>]|^\s*(node |npm |git |python |pip |brew )/m.test(text)) return null;
  if (/\b(STDIN|STDOUT|STDERR|exit code|exited with)\b/i.test(text)) return null;
  if (text.split("\n").length > 10) return null;
  if (/\b[a-f0-9]{40}\b/.test(text)) return null;

  // Skip questions
  if (/^\s*(what|how|why|when|where|who|can|could|should|would|is|are|do|does)\b/i.test(text) && text.includes("?")) return null;
  if (/^(hi|hey|hello|thanks|ok|sure|got it|sounds good)/i.test(text.trim())) return null;

  for (const pattern of CAPTURE_TRIGGERS) {
    if (pattern.test(text)) {
      if (/\b(decided|decision|chose|going with|settled on)\b/i.test(text)) return "decision";
      if (/\b(prefer|always use|never use|switched to)\b/i.test(text)) return "pref";
      return "fact";
    }
  }
  return null;
}

const memoryPlugin = {
  id: "memory-sme",
  name: "Memory (SME)",
  description: "Structured Memory Engine — FTS5, confidence scoring, entity graph, contradiction detection",
  kind: "memory" as const,

  register(api: any) {
    const cfg = api.pluginConfig ?? {};
    const workspace = cfg.workspace ?? api.resolvePath?.(".") ?? process.cwd();
    const autoIndex = cfg.autoIndex !== false;
    const autoRecall = cfg.autoRecall !== false;
    const autoRecallMaxTokens = cfg.autoRecallMaxTokens ?? 1500;
    const autoCapture = cfg.autoCapture !== false;
    const captureMaxChars = cfg.captureMaxChars ?? 500;

    const sme = require("structured-memory-engine");
    const engine = sme.create({ workspace });

    // Auto-index on startup
    if (autoIndex) {
      try {
        const result = engine.index();
        api.logger?.info?.(`memory-sme: indexed ${result.indexed} files (${result.total} total)`);
      } catch (err: any) {
        api.logger?.warn?.(`memory-sme: index failed: ${String(err)}`);
      }
    }

    api.logger?.info?.(`memory-sme: plugin registered (workspace: ${workspace}, autoRecall: ${autoRecall}, autoCapture: ${autoCapture})`);

    // --- Tool: memory_search ---
    api.registerTool({
      name: "memory_search",
      label: "Search Memory",
      description:
        "Search memory using FTS5 full-text search with ranked results, confidence scoring, and recency weighting.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 10)", default: 10 })
        ),
        since: Type.Optional(
          Type.String({
            description: "Time filter — relative (7d, 2w, 3m, 1y) or absolute (2026-01-01)",
          })
        ),
        type: Type.Optional(
          Type.String({
            description: "Filter by chunk type: fact, confirmed, inferred, decision, preference, opinion, outdated",
          })
        ),
        minConfidence: Type.Optional(
          Type.Number({ description: "Minimum confidence threshold (0-1)" })
        ),
      }),
      async execute(_id: string, params: any) {
        const results = engine.query(params.query, {
          limit: params.limit ?? 10,
          since: params.since,
          type: params.type,
          minConfidence: params.minConfidence,
        });

        const text = results.length === 0
          ? "No results found."
          : results
              .map(
                (r: any, i: number) =>
                  `${i + 1}. [${r.chunkType}] ${r.filePath}:${r.lineStart}-${r.lineEnd} (score: ${r.finalScore.toFixed(2)}, confidence: ${r.confidence})\n   ${r.content.slice(0, 200)}`
              )
              .join("\n\n");

        return {
          content: [{ type: "text", text }],
        };
      },
    });

    // --- Tool: memory_remember ---
    api.registerTool({
      name: "memory_remember",
      label: "Remember",
      description:
        "Save a fact, decision, or preference to memory. Written to today's memory log and immediately indexed.",
      parameters: Type.Object({
        content: Type.String({ description: "What to remember" }),
        tag: Type.Optional(
          Type.String({ description: "Memory type tag: fact, decision, pref, opinion, confirmed, inferred (default: fact)" })
        ),
      }),
      async execute(_id: string, params: any) {
        const result = engine.remember(params.content, {
          tag: params.tag ?? "fact",
        });
        return {
          content: [
            {
              type: "text",
              text: `Remembered: [${params.tag ?? "fact"}] ${params.content}\nSaved to: ${result.filePath}`,
            },
          ],
        };
      },
    });

    // --- Tool: memory_reflect ---
    api.registerTool({
      name: "memory_reflect",
      label: "Reflect",
      description:
        "Run memory maintenance cycle — decay, reinforcement, staleness detection, contradiction detection, and pruning.",
      parameters: Type.Object({
        dryRun: Type.Optional(
          Type.Boolean({ description: "Preview changes without applying (default: false)" })
        ),
      }),
      async execute(_id: string, params: any) {
        const result = engine.reflect({ dryRun: params.dryRun ?? false });
        const parts = [
          `Decay: ${result.decay?.decayed ?? 0} chunks`,
          `Reinforce: ${result.reinforce?.reinforced ?? 0} chunks`,
          `Stale: ${result.stale?.marked ?? 0} chunks`,
          `Contradictions: ${result.contradictions?.found ?? 0} found`,
          `Prune: ${result.prune?.archived ?? 0} archived`,
        ];
        if (params.dryRun) parts.unshift("(dry run)");
        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      },
    });

    // --- Lifecycle hook: before_agent_start (auto-recall) ---
    if (autoRecall) {
      // Bug 3: Dedup recall — OpenClaw fires before_agent_start twice per message
      let _lastRecallPrompt = "";
      let _lastRecallResult: any = undefined;
      let _lastRecallTime = 0;

      api.on("before_agent_start", async (event: any) => {
        if (!event?.prompt || event.prompt.length < 5) return;

        // Bug 6: Skip recall for cron/scheduled prompts — they have their own context
        if (/Cron:|scheduled reminder|handle this reminder|\[cron:/i.test(event.prompt)) return;

        // Bug 3: Deduplicate calls within 5s with same prompt
        const cleanPrompt = stripConversationMeta(event.prompt);
        const now = Date.now();
        if (cleanPrompt === _lastRecallPrompt && (now - _lastRecallTime) < 5000) {
          return _lastRecallResult;
        }

        try {
          const result = await engine.context(cleanPrompt, {
            maxTokens: autoRecallMaxTokens,
          });

          _lastRecallPrompt = cleanPrompt;
          _lastRecallTime = now;

          if (!result.text || result.chunks.length === 0) {
            _lastRecallResult = undefined;
            return;
          }

          api.logger?.info?.(
            `memory-sme: injecting ${result.chunks.length} chunks (${result.tokenEstimate} tokens)`
          );

          _lastRecallResult = { prependContext: result.text };
          return _lastRecallResult;
        } catch (err: any) {
          api.logger?.warn?.(`memory-sme: CIL recall failed: ${String(err)}`);
        }
      });
    }

    // --- Lifecycle hook: agent_end (auto-capture) ---
    if (autoCapture) {
      // Bug 7: Track processed message count — only evaluate NEW messages each turn
      let _lastProcessedIndex = 0;

      api.on("agent_end", async (event: any) => {
        const messages = event?.messages;
        if (!Array.isArray(messages)) return;

        // Only process messages we haven't seen yet
        const newMessages = messages.slice(_lastProcessedIndex);
        _lastProcessedIndex = messages.length;

        let captured = 0;
        const MAX_CAPTURES_PER_TURN = 3;

        for (const msg of newMessages) {
          if (captured >= MAX_CAPTURES_PER_TURN) break;
          if (msg.role !== "user") continue;

          const rawText = typeof msg.content === "string"
            ? msg.content
            : msg.content?.map?.((b: any) => b.text ?? "").join(" ") ?? "";

          if (!rawText || rawText.length < 20) continue;

          // Bug 1: Strip conversation metadata before evaluation
          const text = stripConversationMeta(rawText);
          if (!text || text.length < 20) continue;

          const tag = shouldCapture(text);
          if (!tag) continue;

          const truncated = text.length > captureMaxChars
            ? text.slice(0, captureMaxChars) + "…"
            : text;

          try {
            const result = await engine.remember(truncated, { tag });
            if (result.skipped) continue; // Bug 2a: SME-level dedup caught it
            captured++;
            api.logger?.info?.(
              `memory-sme: auto-captured [${tag}] ${truncated.slice(0, 60)}…`
            );
          } catch (err: any) {
            api.logger?.warn?.(`memory-sme: auto-capture failed: ${String(err)}`);
          }
        }
      });
    }

    // --- Service (cleanup on shutdown) ---
    api.registerService({
      id: "memory-sme",
      start: () => {
        api.logger?.info?.("memory-sme: service started");
      },
      stop: () => {
        engine.close();
        api.logger?.info?.("memory-sme: closed");
      },
    });
  },
};

export default memoryPlugin;
