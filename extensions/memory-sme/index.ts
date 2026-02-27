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

export default function plugin(api: any) {
  let engine: any = null;

  api.register({
    name: "memory-sme",

    async register(ctx: any) {
      const config: PluginConfig = ctx.config ?? {};
      const workspace = config.workspace ?? ctx.workspace;
      const autoIndex = config.autoIndex !== false;

      const sme = require("structured-memory-engine");
      engine = sme.create({ workspace });

      // Merge fileTypeDefaults from plugin config into SME's config if provided
      if (config.fileTypeDefaults) {
        const configPath = join(workspace, ".memory", "config.json");
        try {
          const existing = JSON.parse(readFileSync(configPath, "utf-8"));
          existing.fileTypeDefaults = {
            ...existing.fileTypeDefaults,
            ...config.fileTypeDefaults,
          };
          // Don't write back — SME reads config on create(). The merge
          // happens at the SME level via loadConfig. For runtime override,
          // the user edits .memory/config.json directly.
        } catch {
          // No existing config — that's fine, SME uses defaults
        }
      }

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
            `Decay: ${result.decay?.affected ?? 0} chunks`,
            `Reinforce: ${result.reinforce?.affected ?? 0} chunks`,
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

      // --- Lifecycle hook: before_agent_start ---
      if (autoIndex) {
        api.on("before_agent_start", async () => {
          try {
            engine.index();
          } catch {
            // Index failure is non-fatal — agent still starts
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
