import type { AgentId, TaskResult, TaskSpec } from "../types.js";

export type AgentContext = {
  goal: string;
  shared: Record<string, unknown>;
  resultsSoFar: TaskResult[];
};

export interface Agent {
  readonly id: AgentId;
  readonly role: string;
  run(task: TaskSpec, ctx: AgentContext): Promise<Omit<TaskResult, "startedAt" | "finishedAt">>;
}

