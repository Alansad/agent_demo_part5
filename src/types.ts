export type AgentId = string;

export type TaskStatus = "queued" | "running" | "succeeded" | "failed";

export type TaskSpec = {
  id: string;
  title: string;
  description: string;
  assignee: AgentId;
  dependsOn?: string[];
};

export type TaskResult = {
  taskId: string;
  assignee: AgentId;
  status: TaskStatus;
  startedAt: number;
  finishedAt: number;
  output: string;
  artifacts?: Record<string, unknown>;
  error?: string;
};

export type OrchestratorConfig = {
  concurrency: number;
  taskTimeoutMs: number;
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };
  trace: {
    enabled: boolean;
  };
};

export type TraceEvent =
  | {
      type: "orchestrator_started";
      at: number;
      goal: string;
      config: OrchestratorConfig;
    }
  | {
      type: "plan_created";
      at: number;
      tasks: TaskSpec[];
    }
  | {
      type: "task_started";
      at: number;
      taskId: string;
      assignee: AgentId;
      attempt: number;
    }
  | {
      type: "task_succeeded";
      at: number;
      taskId: string;
      assignee: AgentId;
      attempt: number;
      outputPreview: string;
    }
  | {
      type: "task_failed";
      at: number;
      taskId: string;
      assignee: AgentId;
      attempt: number;
      error: string;
    }
  | {
      type: "final_assembled";
      at: number;
      summary: string;
    };

