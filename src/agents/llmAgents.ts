import { z } from "zod";
import type { Agent, AgentContext } from "./agent.js";
import type { AgentId, TaskResult, TaskSpec } from "../types.js";
import type { AnthropicClient } from "../llm/anthropic.js";
import { extractJsonObject } from "../llm/json.js";

const AgentIdSchema = z.enum([
  "agent_product",
  "agent_frontend",
  "agent_qa",
  "agent_writer",
  "agent_manager",
]);

const TaskSpecSchema: z.ZodType<TaskSpec> = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  assignee: AgentIdSchema,
  dependsOn: z.array(z.string().min(1)).optional(),
});

const PlanSchema = z.object({
  scenario: z.string().min(1),
  tasks: z.array(TaskSpecSchema).min(2),
});

export type PlannerOutput = z.infer<typeof PlanSchema>;

export class LlmPlanner {
  constructor(private readonly llm: AnthropicClient) {}

  async createPlan(params: {
    goal: string;
    context?: string;
    maxTasks: number;
  }): Promise<PlannerOutput> {
    const system = [
      "你是一个“多Agent编排系统”的主规划器（Master Agent）。",
      "你的工作：把用户目标拆成可并行的子任务，分配给不同角色执行，并明确依赖关系。",
      "",
      "输出要求：只输出一个 JSON 对象，不要 Markdown，不要解释文字。",
      "JSON 结构：",
      "{",
      '  "scenario": string,',
      '  "tasks": TaskSpec[]',
      "}",
      "",
      "TaskSpec 结构：",
      "{ id, title, description, assignee, dependsOn? }",
      "",
      "assignee 必须是以下之一：",
      "- agent_product（产品）",
      "- agent_frontend（前端工程）",
      "- agent_qa（测试）",
      "- agent_writer（文档/教学）",
      "- agent_manager（主控汇总）",
      "",
      "约束：",
      `- tasks 数量 <= ${params.maxTasks}`,
      "- 任务要真实可执行，且包含明确产出物（deliverable）。",
      "- 可以并行的任务就并行（不要全部串行），用 dependsOn 表达依赖。",
      "- 最后必须有 1 个 agent_manager 的汇总任务，dependsOn 包含所有关键子任务。",
      "- id 用 t1/t2/t3...，不要重复。",
    ].join("\n");

    const user = [
      `目标：${params.goal}`,
      params.context ? "" : undefined,
      params.context ? "上下文（可用信息）：" : undefined,
      params.context ? params.context : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    const { text } = await this.llm.completeText({
      system,
      messages: [{ role: "user", content: user }],
      temperature: 0.2,
    });

    const json = extractJsonObject(text);
    const parsed = PlanSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Planner output schema invalid: ${parsed.error.message}`);
    }

    validatePlan(parsed.data.tasks);
    return parsed.data;
  }
}

function validatePlan(tasks: TaskSpec[]) {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`Duplicate task id: ${t.id}`);
    ids.add(t.id);
  }

  // deps must exist
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`Task ${t.id} depends on unknown task: ${dep}`);
    }
  }

  // simple cycle check via DFS
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cycle detected at task: ${id}`);
    visiting.add(id);
    const t = byId.get(id);
    for (const dep of t?.dependsOn ?? []) dfs(dep);
    visiting.delete(id);
    visited.add(id);
  };

  for (const t of tasks) dfs(t.id);
}

export class LlmWorkerAgent implements Agent {
  constructor(
    public readonly id: AgentId,
    public readonly role: string,
    private readonly llm: AnthropicClient,
    private readonly systemPrompt: string,
  ) {}

  async run(task: TaskSpec, ctx: AgentContext): Promise<Omit<TaskResult, "startedAt" | "finishedAt">> {
    const resultsSoFar = Array.isArray(ctx.resultsSoFar) ? ctx.resultsSoFar : [];
    const contextBrief = resultsSoFar
      .map((r) => {
        const head = `${r.assignee}/${r.taskId}/${r.status}`;
        const body = r.output ? r.output.slice(0, 800) : "";
        return `${head}\n${body}`;
      })
      .join("\n\n---\n\n");

    const user = [
      `全局目标：${ctx.goal}`,
      "",
      `当前任务：${task.title}`,
      `任务描述：${task.description}`,
      "",
      "要求：",
      "- 输出必须可直接用于工程推进（有清晰结构与可执行项）。",
      "- 如果需要假设，请显式写出假设与风险。",
      "",
      contextBrief ? "已有上下文（其他Agent产出，可能不完整）：" : undefined,
      contextBrief ? contextBrief : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    const { text } = await this.llm.completeText({
      system: this.systemPrompt,
      messages: [{ role: "user", content: user }],
      temperature: 0.3,
    });

    return {
      taskId: task.id,
      assignee: this.id,
      status: "succeeded",
      output: text.trim(),
      artifacts: { type: "llm_text", role: this.role },
    };
  }
}

export function createDefaultRoleAgents(llm: AnthropicClient): Agent[] {
  return [
    new LlmWorkerAgent(
      "agent_product",
      "产品",
      llm,
      [
        "你是资深产品经理。",
        "交付：需求澄清、用户故事、验收标准、范围拆分、里程碑。",
        "输出要结构化（标题/列表），避免空话。",
      ].join("\n"),
    ),
    new LlmWorkerAgent(
      "agent_frontend",
      "前端工程",
      llm,
      [
        "你是资深前端工程师/Tech Lead。",
        "交付：技术方案、模块拆分、关键接口、风险与取舍、可落地的实现步骤。",
        "尽量给出 TypeScript/React/Vue 的具体落地方向（按任务需要）。",
      ].join("\n"),
    ),
    new LlmWorkerAgent(
      "agent_qa",
      "测试",
      llm,
      [
        "你是测试负责人（偏工程化）。",
        "交付：测试策略、用例覆盖、边界条件、自动化建议、可观测性建议。",
        "优先列出能阻断上线的高风险点。",
      ].join("\n"),
    ),
    new LlmWorkerAgent(
      "agent_writer",
      "文档/教学",
      llm,
      [
        "你是技术写作者/讲师。",
        "交付：把方案写成可教学的步骤，包含概念解释 + 练习题 + 评估标准。",
        "不要泛泛而谈，要能指导一个工程师照做。",
      ].join("\n"),
    ),
    new LlmWorkerAgent(
      "agent_manager",
      "主控汇总",
      llm,
      [
        "你是主控汇总Agent（Manager）。",
        "目标：把多个子任务输出汇总成一个可执行的最终报告。",
        "必须包含：结论、范围、里程碑、风险清单、下一步TODO（按优先级）。",
        "如果子输出冲突，明确决策规则与建议取舍。",
      ].join("\n"),
    ),
  ];
}
