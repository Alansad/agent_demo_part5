import { Send, START, END, StateGraph, StateSchema, ReducedValue } from "@langchain/langgraph";
import { z } from "zod";
import pRetry from "p-retry";
import pTimeout from "p-timeout";
import type { Agent, AgentContext } from "../agents/agent.js";
import type { OrchestratorConfig, TaskResult, TaskSpec, TraceEvent } from "../types.js";

const TaskSpecSchema: z.ZodType<TaskSpec> = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  assignee: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
});

const TaskResultSchema: z.ZodType<TaskResult> = z.object({
  taskId: z.string().min(1),
  assignee: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  startedAt: z.number(),
  finishedAt: z.number(),
  output: z.string(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

const TraceEventSchema: z.ZodType<TraceEvent> = z.any();

const GraphState = new StateSchema({
  goal: z.string(),
  tasks: z.array(TaskSpecSchema),
  task: TaskSpecSchema.optional(),
  shared: z.record(z.string(), z.unknown()).default(() => ({})),
  results: new ReducedValue(z.array(TaskResultSchema).default(() => []), {
    inputSchema: z.array(TaskResultSchema),
    reducer: (current, next) => current.concat(next),
  }),
  completed: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.array(z.string()),
    reducer: (current, next) => {
      const set = new Set(current);
      for (const id of next) set.add(id);
      return [...set];
    },
  }),
  trace: new ReducedValue(z.array(TraceEventSchema).default(() => []), {
    inputSchema: z.array(TraceEventSchema),
    reducer: (current, next) => current.concat(next),
  }),
});

type State = typeof GraphState.State;
type Update = typeof GraphState.Update;

export async function runWithLangGraph(params: {
  goal: string;
  tasks: TaskSpec[];
  agents: Agent[];
  config: OrchestratorConfig;
  shared?: Record<string, unknown>;
  onTraceEvent?: (event: TraceEvent) => void;
  onTaskResult?: (result: TaskResult) => void;
}): Promise<{ final: string; results: TaskResult[]; trace: TraceEvent[] }> {
  validateTasksOrThrow(params.tasks);
  const byId = new Map(params.tasks.map((t) => [t.id, t] as const));
  const agentById = new Map(params.agents.map((a) => [a.id, a] as const));

  const dispatch = async (state: State): Promise<Update> => {
    const completed = new Set(state.completed);
    const failed = new Set(state.results.filter((r) => r.status === "failed").map((r) => r.taskId));
    const succeeded = new Set(state.results.filter((r) => r.status === "succeeded").map((r) => r.taskId));

    const blocked: TaskSpec[] = [];
    const runnable: TaskSpec[] = [];
    const pending: TaskSpec[] = [];
    for (const task of state.tasks) {
      if (completed.has(task.id)) continue;
      const deps = task.dependsOn ?? [];
      if (deps.some((d) => failed.has(d))) {
        blocked.push(task);
        continue;
      }
      if (deps.length === 0 || deps.every((d) => succeeded.has(d))) {
        runnable.push(task);
        continue;
      }
      pending.push(task);
    }

    if (blocked.length === 0 && runnable.length > 0) return {};

    const now = Date.now();
    const failTasks = blocked.length > 0 ? blocked : pending;
    const errorPrefix =
      blocked.length > 0
        ? "Blocked by failed dependency"
        : "Deadlock: no runnable tasks (unmet dependencies)";

    const blockedResults: TaskResult[] = failTasks.map((task) => {
      const deps = task.dependsOn ?? [];
      const unmet = deps.filter((d) => !succeeded.has(d));
      const detail =
        blocked.length > 0
          ? deps.join(", ")
          : unmet.length > 0
            ? `unmet deps: ${unmet.join(", ")}`
            : "unknown";
      return {
        taskId: task.id,
        assignee: task.assignee,
        status: "failed",
        startedAt: now,
        finishedAt: now,
        output: "",
        error: `${errorPrefix}: ${detail}`,
      };
    });

    for (const r of blockedResults) params.onTaskResult?.(r);
    for (const t of failTasks) {
      const ev: TraceEvent = {
        type: "task_failed",
        at: now,
        taskId: t.id,
        assignee: t.assignee,
        error: blocked.length > 0 ? "blocked" : "deadlock",
      };
      params.onTraceEvent?.(ev);
    }

    return {
      results: blockedResults,
      completed: failTasks.map((t) => t.id),
      trace: failTasks.map((t) => ({
        type: "task_failed",
        at: now,
        taskId: t.id,
        assignee: t.assignee,
        error: blocked.length > 0 ? "blocked" : "deadlock",
      })),
    };
  };

  const route = (state: State) => {
    const completed = new Set(state.completed);
    if (completed.size >= state.tasks.length) return END;

    const succeeded = new Set(state.results.filter((r) => r.status === "succeeded").map((r) => r.taskId));
    const failed = new Set(state.results.filter((r) => r.status === "failed").map((r) => r.taskId));

    const runnable = state.tasks.filter((task) => {
      if (completed.has(task.id)) return false;
      const deps = task.dependsOn ?? [];
      if (deps.some((d) => failed.has(d))) return false;
      return deps.every((d) => succeeded.has(d));
    });

    if (runnable.length === 0) return "dispatch";

    // IMPORTANT:
    // LangGraph `Send` allows invoking a node with a custom state that may differ from the core graph state.
    // To avoid losing fields (e.g. results/goal) when the node runs, pass the full state + the task.
    return runnable.map(
      (task) =>
        new Send("run_task", {
          goal: state.goal,
          tasks: state.tasks,
          task,
          shared: state.shared,
          results: state.results,
          completed: state.completed,
          trace: state.trace,
        }),
    );
  };

  const runTask = async (state: State): Promise<Update> => {
    const task = state.task;
    if (!task) throw new Error("Missing task in state for run_task");

    const agent = agentById.get(task.assignee);
    const startedAt = Date.now();

    const startedEv: TraceEvent = { type: "task_started", at: startedAt, taskId: task.id, assignee: task.assignee };
    params.onTraceEvent?.(startedEv);
    const baseTrace: TraceEvent[] = [startedEv];

    if (!agent) {
      const finishedAt = Date.now();
      const result: TaskResult = {
        taskId: task.id,
        assignee: task.assignee,
        status: "failed",
        startedAt,
        finishedAt,
        output: "",
        error: `Unknown agent: ${task.assignee}`,
      };
      return {
        results: [result],
        completed: [task.id],
        trace: baseTrace.concat([
          { type: "task_failed", at: finishedAt, taskId: task.id, assignee: task.assignee, error: result.error ?? "unknown" },
        ]),
      };
    }

    const ctx: AgentContext = {
      goal: state.goal,
      shared: state.shared,
      resultsSoFar: state.results,
    };

    try {
      const out = await pRetry(
        async (attempt) => {
          const value = await pTimeout(agent.run(task, ctx), {
            milliseconds: params.config.taskTimeoutMs,
            message: `Task ${task.id} timed out after ${params.config.taskTimeoutMs}ms`,
          });
          return { attempt, value };
        },
        {
          retries: Math.max(0, params.config.retry.maxAttempts - 1),
          factor: 1,
          minTimeout: params.config.retry.backoffMs,
          maxTimeout: params.config.retry.backoffMs,
        },
      );

      const finishedAt = Date.now();
      const result: TaskResult = {
        ...out.value,
        status: "succeeded",
        startedAt,
        finishedAt,
      };
      params.onTaskResult?.(result);

      const succEv: TraceEvent = {
        type: "task_succeeded",
        at: finishedAt,
        taskId: task.id,
        assignee: task.assignee,
        outputPreview: result.output.slice(0, 120),
        attempt: out.attempt,
      };
      params.onTraceEvent?.(succEv);
      return {
        results: [result],
        completed: [task.id],
        trace: baseTrace.concat([succEv]),
      };
    } catch (err) {
      const finishedAt = Date.now();
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? err.stack : undefined;
      const result: TaskResult = {
        taskId: task.id,
        assignee: task.assignee,
        status: "failed",
        startedAt,
        finishedAt,
        output: "",
        error: stack ? `${message}\n\n---\n${stack}` : message,
      };
      params.onTaskResult?.(result);

      const failEv: TraceEvent = { type: "task_failed", at: finishedAt, taskId: task.id, assignee: task.assignee, error: message };
      params.onTraceEvent?.(failEv);

      return {
        results: [result],
        completed: [task.id],
        trace: baseTrace.concat([failEv]),
      };
    }
  };

  const graph = new StateGraph(GraphState)
    .addNode("dispatch", dispatch)
    .addNode("run_task", runTask)
    .addEdge(START, "dispatch")
    .addConditionalEdges("dispatch", route)
    .addEdge("run_task", "dispatch")
    .compile();

  const initial: State = {
    goal: params.goal,
    tasks: params.tasks,
    task: undefined,
    results: [],
    completed: [],
    trace: [],
    shared: params.shared ?? {},
  };

  const started: TraceEvent = { type: "orchestrator_started", at: Date.now(), goal: params.goal, config: params.config };
  const planned: TraceEvent = { type: "plan_created", at: Date.now(), tasks: params.tasks };
  params.onTraceEvent?.(started);
  params.onTraceEvent?.(planned);
  initial.trace = [started, planned];

  const finalState = await graph.invoke(initial, {
    // Let the LangGraph runtime handle concurrency.
    maxConcurrency: Math.max(1, params.config.concurrency),
  } as any);

  const final = assembleFinal(params.goal, params.tasks, finalState.results);
  const assembled: TraceEvent = { type: "final_assembled", at: Date.now(), summary: final.slice(0, 160) };
  params.onTraceEvent?.(assembled);
  const trace = finalState.trace.concat([assembled]);
  return { final, results: finalState.results, trace };
}

function validateTasksOrThrow(tasks: TaskSpec[]) {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`Duplicate task id: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`Task ${t.id} depends on unknown task: ${dep}`);
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cycle detected at task: ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) dfs(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const t of tasks) dfs(t.id);
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
  lines.push("- 把 trace 落盘并前端可视化（LangGraph stream/tasks/debug 模式也可用于可视化）。");
  lines.push("- 把 Worker 输出升级为结构化 artifacts（JSON schema），再做结构化汇总。");

  return lines.join("\n");
}
