import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { AnthropicClient, type AnthropicConfig } from "./llm/anthropic.js";
import { LlmPlanner, createDefaultRoleAgents } from "./agents/llmAgents.js";
import { runWithLangGraph } from "./orchestrator/langgraph.js";
import { findScenario, SCENARIOS } from "./scenarios.js";
import type { OrchestratorConfig } from "./types.js";

const RunRequestSchema = z.object({
  scenario: z.string().optional(),
  goal: z.string().optional(),
  maxTasks: z.number().int().min(2).max(20).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  backoffMs: z.number().int().min(0).max(30_000).optional(),
  debug: z.boolean().optional(),
});

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Put it in .env`);
  return v;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req: Request, res: Response) => res.json({ ok: true }));

app.get("/api/scenarios", (_req: Request, res: Response) => {
  res.json({ scenarios: SCENARIOS });
});

app.post("/api/run", async (req: Request, res: Response) => {
  try {
    const parsed = RunRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;
    const scenarioId = body.scenario ?? "frontend-agent-mvp";
    const scenario = findScenario(scenarioId);
    if (!scenario) {
      res.status(400).json({ error: `Unknown scenario: ${scenarioId}`, available: SCENARIOS.map((s) => s.id) });
      return;
    }

    const goal = (body.goal?.trim() ? body.goal.trim() : scenario.title) ?? scenario.title;
    const maxTasks = body.maxTasks ?? 8;

    let apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    let authToken = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
    const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
    const model = requiredEnv("ANTHROPIC_MODEL");

    if (!authToken && apiKey && /volces\\.com/i.test(baseUrl)) {
      authToken = apiKey;
      apiKey = "";
    }
    if (!apiKey && !authToken) {
      res.status(500).json({ error: "Missing ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN for bearer auth) in .env" });
      return;
    }

    const llmCfg: AnthropicConfig = {
      apiKey,
      authToken,
      baseUrl,
      model,
      maxTokens: 1800,
      timeoutMs: 120_000,
      debug: body.debug ?? (process.env.LLM_DEBUG ?? "false") === "true",
    };
    const llm = new AnthropicClient(llmCfg);

    const planner = new LlmPlanner(llm);
    const plan = await planner.createPlan({ goal, context: scenario.prompt, maxTasks });

    const config: OrchestratorConfig = {
      concurrency: body.concurrency ?? 3,
      taskTimeoutMs: body.timeoutMs ?? 60_000,
      retry: {
        maxAttempts: body.maxAttempts ?? 2,
        backoffMs: body.backoffMs ?? 800,
      },
      trace: { enabled: true },
    };

    const agents = createDefaultRoleAgents(llm);
    const { final, results, trace } = await runWithLangGraph({
      goal,
      tasks: plan.tasks,
      agents,
      config,
    });

    res.json({
      scenario: { id: scenario.id, title: scenario.title },
      goal,
      config,
      plan,
      final,
      results,
      trace,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : undefined;
    res.status(500).json({ error: message, stack });
  }
});

// Static demo UI
app.use("/", express.static("public"));

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";
const server = app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Demo UI: http://${host}:${port}`);
});
server.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[server] listen error:", err);
  process.exitCode = 1;
});
