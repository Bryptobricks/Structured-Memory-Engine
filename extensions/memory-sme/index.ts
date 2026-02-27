import { Type } from "@sinclair/typebox";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { resolve, join } from "path";

const require = createRequire(import.meta.url);

interface PluginConfig {
  workspace?: string;
  fileTypeDefaults?: Record<string, string>;
  reflectInterval?: string;
  autoIndex?: boolean;
  autoRecall?: boolean;
  autoRecallMaxTokens?: number;
  autoCapture?: boolean;
  captureMaxChars?: number;
}

interface SMEResult {
  content: string;
  heading: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  finalScore: number;
  score: number;
  confidence: number;
  chunkType: string;
  entities: string[];
  date: string;
}

// Patterns that indicate content worth capturing automatically
const CAPTURE_TRIGGERS = [
  /\b(decided|decision|choosing|chose|picked|going with|settled on)\b/i,
  /\b(prefer|preference|always use|never use|switched to|moving to)\b/i,
  /\b(remember|don't forget|note to self|important:|key takeaway)\b/i,
  /\b(learned|realized|discovered|turns out|found out)\b/i,
  /\b(started|stopped|quit|dropped|added|removed|changed)\b.{5,}\b(daily|weekly|routine|protocol|stack|dose)\b/i,
  /\b(agreed|committed|promised|scheduled|deadline)\b/i,
];

function shouldCapture(text: string): string | null {
  if (!text || text.length < 20) return null;
  // Skip if it looks like a question
  if (/^\s*(what|how|why|when|where|who|can|could|should|would|is|are|do|does)\b/i.test(text) && text.includes("?")) return null;
  // Skip greetings / filler
  if (/^(hi|hey|hello|thanks|ok|sure|got it|sounds good)/i.test(text.trim())) return null;

  for (const pattern of CAPTURE_TRIGGERS) {
    if (pattern.test(text)) {
      // Infer tag from trigger
      if (/\b(decided|decision|chose|going with|settled on)\b/i.test(text)) return "decision";
      if (/\b(prefer|always use|never use|switched to)\b/i.test(text)) return "pref";
      return "fact";
    }
  }
  return null;
}

export default function plugin(api: any) {
  let engine: any = null;

  api.register({
    name: "memory-sme",

    async register(ctx: any) {
      const config: PluginConfig = ctx.config ?? {};
      const workspace = config.workspace ?? ctx.workspace;
      const autoIndex = config.autoIndex !== false;
      const autoRecall = config.autoRecall !== false;
      const autoRecallMaxTokens = config.autoRecallMaxTokens ?? 1500;
      const autoCapture = config.autoCapture !== false;
      const captureMaxChars = config.captureMaxChars ?? 500;

      const sme = require("structured-memory-engine");
      engine = sme.create({ workspace });

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
              description:
                "Time filter — relative (7d, 2w, 3m, 1y) or absolute (2026-01-01)",
            })
          ),
          type: Type.Optional(
            Type.String({
              description:
                "Filter by chunk type: fact, confirmed, inferred, decision, preference, opinion, outdated",
            })
          ),
          minConfidence: Type.Optional(
            Type.Number({
              description: "Minimum confidence threshold (0-1)",
            })
          ),
        }),
        async execute(params: {
          query: string;
          limit?: number;
          since?: string;
          type?: string;
          minConfidence?: number;
        }) {
          const results: SMEResult[] = engine.query(params.query, {
            limit: params.limit ?? 10,
            since: params.since,
            type: params.type,
            minConfidence: params.minConfidence,
          });

          const mapped = results.map((r: SMEResult) => ({
            path: r.filePath,
            startLine: r.lineStart,
            endLine: r.lineEnd,
            score: r.finalScore,
            snippet: r.content,
            source: "memory" as const,
          }));

          const text = results.length === 0
            ? "No results found."
            : results
                .map(
                  (r: SMEResult, i: number) =>
                    `${i + 1}. [${r.chunkType}] ${r.filePath}:${r.lineStart}-${r.lineEnd} (score: ${r.finalScore.toFixed(2)}, confidence: ${r.confidence})\n   ${r.content.slice(0, 200)}`
                )
                .join("\n\n");

          return {
            content: [{ type: "text", text }],
            details: { count: results.length, results: mapped },
          };
        },
      });

      // --- Tool: memory_get ---
      api.registerTool({
        name: "memory_get",
        label: "Read Memory File",
        description:
          "Read a file from the memory workspace by path, optionally limited to a line range.",
        parameters: Type.Object({
          path: Type.String({ description: "File path relative to workspace" }),
          startLine: Type.Optional(
            Type.Number({ description: "Start line (1-based)" })
          ),
          endLine: Type.Optional(
            Type.Number({ description: "End line (1-based, inclusive)" })
          ),
        }),
        async execute(params: {
          path: string;
          startLine?: number;
          endLine?: number;
        }) {
          const fullPath = resolve(workspace, params.path);

          // Prevent path traversal outside workspace
          if (!fullPath.startsWith(resolve(workspace))) {
            return {
              content: [{ type: "text", text: "Error: path outside workspace" }],
              isError: true,
            };
          }

          try {
            const text = readFileSync(fullPath, "utf-8");
            const lines = text.split("\n");

            if (params.startLine || params.endLine) {
              const start = (params.startLine ?? 1) - 1;
              const end = params.endLine ?? lines.length;
              const slice = lines.slice(start, end).join("\n");
              return { content: [{ type: "text", text: slice }] };
            }

            return { content: [{ type: "text", text }] };
          } catch (err: any) {
            return {
              content: [
                { type: "text", text: `Error reading file: ${err.message}` },
              ],
              isError: true,
            };
          }
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
            Type.Union(
              [
                Type.Literal("fact"),
                Type.Literal("decision"),
                Type.Literal("pref"),
                Type.Literal("opinion"),
                Type.Literal("confirmed"),
                Type.Literal("inferred"),
              ],
              { description: "Memory type tag (default: fact)" }
            )
          ),
        }),
        async execute(params: { content: string; tag?: string }) {
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
            Type.Boolean({
              description: "Preview changes without applying (default: false)",
            })
          ),
        }),
        async execute(params: { dryRun?: boolean }) {
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
            details: result,
          };
        },
      });

      // --- Lifecycle hook: before_agent_start (auto-index + auto-recall) ---
      api.on("before_agent_start", async (event: any) => {
        // Auto-index on startup
        if (autoIndex) {
          try {
            engine.index();
          } catch {
            // Index failure is non-fatal — agent still starts
          }
        }

        // Auto-recall: inject relevant context into system prompt
        if (!autoRecall) return;
        if (!event?.prompt || event.prompt.length < 5) return;

        try {
          const result = engine.context(event.prompt, {
            maxTokens: autoRecallMaxTokens,
          });

          if (!result.text) return;

          api.logger?.info?.(
            `memory-sme: injecting ${result.chunks.length} chunks (${result.tokenEstimate} tokens)`
          );

          return {
            prependContext: result.text,
          };
        } catch (err: any) {
          api.logger?.warn?.(`memory-sme: CIL recall failed: ${String(err)}`);
        }
      });

      // --- Lifecycle hook: agent_end (auto-capture) ---
      if (autoCapture) {
        api.on("agent_end", async (event: any) => {
          const messages = event?.messages;
          if (!Array.isArray(messages)) return;

          let captured = 0;
          const MAX_CAPTURES_PER_TURN = 3;

          for (const msg of messages) {
            if (captured >= MAX_CAPTURES_PER_TURN) break;

            // Only capture user messages — skip agent/assistant output
            if (msg.role !== "user") continue;

            const text = typeof msg.content === "string"
              ? msg.content
              : msg.content?.map?.((b: any) => b.text ?? "").join(" ") ?? "";

            if (!text || text.length < 20) continue;

            const tag = shouldCapture(text);
            if (!tag) continue;

            const truncated = text.length > captureMaxChars
              ? text.slice(0, captureMaxChars) + "…"
              : text;

            try {
              engine.remember(truncated, { tag });
              captured++;
              api.logger?.info?.(
                `memory-sme: auto-captured [${tag}] ${truncated.slice(0, 60)}…`
              );
            } catch (err: any) {
              api.logger?.warn?.(
                `memory-sme: auto-capture failed: ${String(err)}`
              );
            }
          }
        });
      }
    },

    async dispose() {
      if (engine) {
        engine.close();
        engine = null;
      }
    },
  });
}

// Export for testing
export { shouldCapture, CAPTURE_TRIGGERS };
