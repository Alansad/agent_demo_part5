import type { Agent, AgentContext } from "../agents/agent.js";
import type { OrchestratorConfig, TaskResult, TaskSpec, TraceEvent } from "../types.js";
import { clip } from "../utils/text.js";
import { sleep, withTimeout } from "../utils/time.js";

type TaskRuntimeState = {
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  result?: TaskResult;
};

export class MultiAgentOrchestrator {
  private readonly agents = new Map<string, Agent>();
  private readonly trace: TraceEvent[] = [];
  private readonly shared: Record<string, unknown>;

  constructor(
    agents: Agent[],
    private readonly config: OrchestratorConfig,
    opts?: { shared?: Record<string, unknown> },
  ) {
    for (const agent of agents) this.agents.set(agent.id, agent);
    this.shared = opts?.shared ?? {};
  }

  getTrace(): TraceEvent[] {
    return [...this.trace];
  }

  private emit(event: TraceEvent) {
    if (!this.config.trace.enabled) return;
    this.trace.push(event);
  }

  async run(goal: string, tasks: TaskSpec[]): Promise<{ results: TaskResult[]; final: string }> {
    this.emit({ type: "orchestrator_started", at: Date.now(), goal, config: this.config });
    this.emit({ type: "plan_created", at: Date.now(), tasks });

    const state = new Map<string, TaskRuntimeState>();
    for (const task of tasks) state.set(task.id, { status: "queued", attempts: 0 });

    const dependents = new Map<string, string[]>();
    for (const task of tasks) {
      for (const dep of task.dependsOn ?? []) {
        dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
      }
    }

    const canStart = (task: TaskSpec): boolean => {
      const deps = task.dependsOn ?? [];
      if (deps.length === 0) return true;
      return deps.every((id) => state.get(id)?.status === "succeeded");
    };

    const pendingQueue: TaskSpec[] = [...tasks];
    const running = new Set<string>();
    const results: TaskResult[] = [];

    const ctxFor = (): AgentContext => ({
      goal,
      shared: this.shared,
      resultsSoFar: [...results],
    });

    const runOne = async (task: TaskSpec): Promise<void> => {
      const agent = this.agents.get(task.assignee);
      if (!agent) {
        const now = Date.now();
        const result: TaskResult = {
          taskId: task.id,
          assignee: task.assignee,
          status: "failed",
          startedAt: now,
          finishedAt: now,
          output: "",
          error: `Unknown agent: ${task.assignee}`,
        };
        state.set(task.id, { status: "failed", attempts: 1, result });
        results.push(result);
        return;
      }

      const runtime = state.get(task.id);
      if (!runtime) return;

      const attempt = runtime.attempts + 1;
      runtime.status = "running";
      runtime.attempts = attempt;
      state.set(task.id, runtime);
      running.add(task.id);
      this.emit({ type: "task_started", at: Date.now(), taskId: task.id, assignee: task.assignee, attempt });

      const startedAt = Date.now();
      try {
        const output = await withTimeout(
          agent.run(task, ctxFor()),
          this.config.taskTimeoutMs,
          `Task ${task.id} timed out after ${this.config.taskTimeoutMs}ms`,
        );
        const finishedAt = Date.now();
        const result: TaskResult = {
          ...output,
          startedAt,
          finishedAt,
          status: "succeeded",
        };
        runtime.status = "succeeded";
        runtime.result = result;
        state.set(task.id, runtime);
        results.push(result);
        this.emit({
          type: "task_succeeded",
          at: finishedAt,
          taskId: task.id,
          assignee: task.assignee,
          attempt,
          outputPreview: clip(result.output.replaceAll("\n", " "), 120),
        });
      } catch (err) {
        const finishedAt = Date.now();
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: "task_failed", at: finishedAt, taskId: task.id, assignee: task.assignee, attempt, error: message });

        const shouldRetry = attempt < this.config.retry.maxAttempts;
        if (shouldRetry) {
          runtime.status = "queued";
          state.set(task.id, runtime);
          await sleep(this.config.retry.backoffMs);
        } else {
          const result: TaskResult = {
            taskId: task.id,
            assignee: task.assignee,
            status: "failed",
            startedAt,
            finishedAt,
            output: "",
            error: message,
          };
          runtime.status = "failed";
          runtime.result = result;
          state.set(task.id, runtime);
          results.push(result);
        }
      } finally {
        running.delete(task.id);
      }
    };

    // Simple scheduler loop:
    // - keep scanning pendingQueue for runnable tasks
    // - start up to concurrency
    // - stop when all tasks are terminal
    while (true) {
      const terminalCount = [...state.values()].filter((s) => s.status === "succeeded" || s.status === "failed").length;
      if (terminalCount === tasks.length) break;

      const availableSlots = Math.max(0, this.config.concurrency - running.size);
      if (availableSlots === 0) {
        await sleep(10);
        continue;
      }

      const runnable: TaskSpec[] = [];
      for (const task of pendingQueue) {
        const st = state.get(task.id);
        if (!st || st.status !== "queued") continue;
        if (!canStart(task)) continue;
        runnable.push(task);
        if (runnable.length >= availableSlots) break;
      }

      if (runnable.length === 0) {
        // Deadlock guard: if there are queued tasks that can never start due to failed deps,
        // mark them failed so the loop can finish.
        let progressed = false;
        for (const task of pendingQueue) {
          const st = state.get(task.id);
          if (!st || st.status !== "queued") continue;
          const deps = task.dependsOn ?? [];
          const hasFailedDep = deps.some((id) => state.get(id)?.status === "failed");
          if (!hasFailedDep) continue;
          const now = Date.now();
          const result: TaskResult = {
            taskId: task.id,
            assignee: task.assignee,
            status: "failed",
            startedAt: now,
            finishedAt: now,
            output: "",
            error: `Blocked by failed dependency: ${deps.join(", ")}`,
          };
          state.set(task.id, { status: "failed", attempts: st.attempts, result });
          results.push(result);
          progressed = true;
        }
        if (!progressed) await sleep(10);
        continue;
      }

      await Promise.all(runnable.map((t) => runOne(t)));
    }

    const final = assembleFinal(goal, tasks, results);
    this.emit({ type: "final_assembled", at: Date.now(), summary: clip(final.replaceAll("\n", " "), 160) });
    return { results, final };
  }
}

function assembleFinal(goal: string, tasks: TaskSpec[], results: TaskResult[]): string {
  const byTaskId = new Map(results.map((r) => [r.taskId, r] as const));
  const lines: string[] = [];

  lines.push(`# 多Agent协作汇总`);
  lines.push(`目标：${goal}`);
  lines.push("");
  lines.push("## 执行结果");
  for (const task of tasks) {
    const r = byTaskId.get(task.id);
    if (!r) {
      lines.push(`- ${task.id} ${task.title}：missing result`);
      continue;
    }
    const costMs = r.finishedAt - r.startedAt;
    if (r.status === "succeeded") lines.push(`- ✅ ${task.id} ${task.title}（${task.assignee}, ${costMs}ms）`);
    else lines.push(`- ❌ ${task.id} ${task.title}（${task.assignee}, ${costMs}ms）：${r.error ?? "unknown error"}`);
  }

  lines.push("");
  lines.push("## 各Agent输出");
  for (const task of tasks) {
    const r = byTaskId.get(task.id);
    if (!r) continue;
    lines.push("");
    lines.push(`### ${task.title} @ ${r.assignee}`);
    if (r.status === "succeeded") lines.push(r.output);
    else lines.push(`失败：${r.error ?? "unknown error"}`);
  }

  lines.push("");
  lines.push("## 下一步（建议）");
  lines.push("- 将 TraceEvent 持久化（JSONL/SQLite），做可视化调试面板（时间轴/泳道）。");
  lines.push("- 把 Agent.run 接到真实 LLM：主Agent生成计划（JSON schema），从Agent执行并产出结构化 artifacts。");
  lines.push("- 引入“评估器/裁判Agent”对各子结果打分，决定是否重试/改写提示词。");

  return lines.join("\n");
}
