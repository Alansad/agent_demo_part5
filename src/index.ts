import "dotenv/config";
import { createDefaultRoleAgents, LlmPlanner } from "./agents/llmAgents.js";
import { runWithLangGraph } from "./orchestrator/langgraph.js";
import type { OrchestratorConfig } from "./types.js";
import { writeFile } from "node:fs/promises";
import { AnthropicClient, type AnthropicConfig } from "./llm/anthropic.js";
import { findScenario, SCENARIOS } from "./scenarios.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const kv = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
    kv.set(key, value);
  }
  return kv;
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const kv = parseArgs(process.argv);
const listScenarios = (kv.get("listScenarios") ?? "false") === "true";
const scenarioId = kv.get("scenario") ?? "frontend-agent-mvp";
const scenario = findScenario(scenarioId);
const goal =
  kv.get("goal") ??
  scenario?.title ??
  "实现 Week 9–10：多Agent协作（主从分工、任务分发、结果汇总）";

const config: OrchestratorConfig = {
  concurrency: toInt(kv.get("concurrency"), 2),
  taskTimeoutMs: toInt(kv.get("timeoutMs"), 60_000),
  retry: {
    maxAttempts: toInt(kv.get("maxAttempts"), 2),
    backoffMs: toInt(kv.get("backoffMs"), 800),
  },
  trace: {
    enabled: (kv.get("trace") ?? "true") === "true",
  },
};

const traceFile = kv.get("traceFile"); // e.g. trace.json
const outputFile = kv.get("outputFile"); // e.g. report.md
const viz = (kv.get("viz") ?? "false") === "true";
const maxTasks = toInt(kv.get("maxTasks"), 8);
const failOnceAssignee = kv.get("failOnceAssignee"); // e.g. agent_product

let apiKey = kv.get("apiKey") ?? process.env.ANTHROPIC_API_KEY ?? "";
let authToken = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
const baseUrl = kv.get("apiUrl") ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const model = kv.get("model") ?? process.env.ANTHROPIC_MODEL ?? "";
const maxTokens = toInt(kv.get("maxTokens"), 1800);
const llmTimeoutMs = toInt(kv.get("llmTimeoutMs"), 120_000);
const debug = (kv.get("debug") ?? process.env.LLM_DEBUG ?? "false") === "true";

if (listScenarios) {
  console.log("Available scenarios:");
  for (const s of SCENARIOS) console.log(`- ${s.id}: ${s.title}`);
  process.exit(0);
}

if (!scenario && scenarioId) {
  console.error(`[warn] unknown scenario "${scenarioId}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
}

// Many third-party "Anthropic-compatible" gateways (e.g. Volcengine Ark) use Bearer auth.
// Auto-detect common cases to avoid extra config knobs.
if (!authToken && apiKey && /volces\\.com/i.test(baseUrl)) {
  authToken = apiKey;
  apiKey = "";
}

if (!apiKey && !authToken) throw new Error("Missing credentials. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN for bearer auth)");
if (!model) throw new Error("Missing model. Pass --model or set ANTHROPIC_MODEL");

const llmCfg: AnthropicConfig = {
  apiKey,
  authToken,
  baseUrl,
  model,
  maxTokens,
  timeoutMs: llmTimeoutMs,
  debug,
};
const llm = new AnthropicClient(llmCfg);

const planner = new LlmPlanner(llm);
const context = scenario?.prompt;
const plan = await planner.createPlan({ goal, context, maxTasks });
const tasks = plan.tasks;

const agents = createDefaultRoleAgents(llm);
const { final, results, trace } = await runWithLangGraph({
  goal,
  tasks,
  agents,
  config,
  shared: failOnceAssignee ? { failOnceAssignee } : undefined,
});

console.log(final);

if (viz) {
  const byAgent = new Map<string, typeof results>();
  for (const r of results) byAgent.set(r.assignee, [...(byAgent.get(r.assignee) ?? []), r]);
  console.log("\n---\n# Timeline（简单泳道）");
  for (const [assignee, rs] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const chunks = rs
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => {
        const ms = r.finishedAt - r.startedAt;
        const badge = r.status === "succeeded" ? "✅" : "❌";
        return `${badge}${r.taskId}(${ms}ms)`;
      })
      .join("  ");
    console.log(`- ${assignee}: ${chunks}`);
  }
}

if (config.trace.enabled) {
  console.log("\n---\n# TraceEvent（用于前端可视化）");
  console.log(JSON.stringify(trace, null, 2));
}

if (traceFile) {
  await writeFile(traceFile, JSON.stringify(trace, null, 2), "utf8");
  console.error(`\n[trace] written to ${traceFile}`);
}

if (outputFile) {
  const payload = [
    final,
    "",
    "---",
    "## Raw Results",
    "```json",
    JSON.stringify(results, null, 2),
    "```",
  ].join("\n");
  await writeFile(outputFile, payload, "utf8");
  console.error(`\n[report] written to ${outputFile}`);
}
