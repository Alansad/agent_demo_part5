# 实验式学习路线（手把手改代码）

目标：你不需要“背概念”，只要做完这几组实验，就能真正理解：
- Master（规划）/ Worker（执行）/ Orchestrator（编排）的边界
- 依赖、并发、重试、阻塞（blocked）在系统里如何发生
- Trace 是怎么驱动可视化的

建议你用 Web 演示模式做实验：`npm run web`，打开页面后边改边跑。

---

## 实验 0：先把系统跑通（5 分钟）

1) 配置 `.env`：复制 `.env.example` → `.env`，填 `ANTHROPIC_MODEL` 和密钥相关配置  
2) 启动：`npm run web`  
3) 页面点“运行（流式）”，观察执行顺序：
- 先出现 Plan（任务列表/依赖/分工）
- 然后逐个出现 task_result（时间轴实时增长）
- 最后出现 Final（汇总报告）

你需要知道的文件：
- Web 服务入口：`src/server.ts`
- 前端页面：`public/app.js`

---

## 实验 1：看懂 Plan（改场景提示词）

目标：理解“任务不是写死的”，是 Planner 生成出来的。

打开 `src/scenarios.ts`，找到 `frontend-agent-mvp` 的 `prompt`，在末尾追加一条约束，比如：
- “必须包含一个里程碑：第 1 天可跑通 demo”

保存后重新运行页面，观察：
- Plan 的任务数量、标题、依赖关系是否发生变化

原理：
- Planner 在 `src/agents/llmAgents.ts` 里，根据 `goal + scenario.prompt` 生成 `TaskSpec[]`

---

## 实验 2：演示“重试”（不用浪费模型额度）

目标：让某个 Agent **第一次必失败**，第二次成功，从而直观理解 retry。

在页面把“实验：失败一次”设为 `agent_product`，再运行。

你会看到：
- Trace 里同一个 task 会出现多次 `task_started`（带 attempt）
- 第一次失败会有 `task_failed`（带 attempt）
- 后续 attempt 成功后进入 `task_succeeded`

对应代码：
- 注入失败：`src/agents/llmAgents.ts`（`failOnceAssignee`）
- retry/attempt 事件：`src/orchestrator/langgraph.ts`

扩展（可选）：
- 把页面里的“最大重试”调成 1，看看失败会如何向下游传播（blocked）。

---

## 实验 3：演示“依赖阻塞 blocked”

目标：理解 dependsOn 的作用，以及为什么会出现 `Blocked by failed dependency`。

步骤：
1) 页面 “最大重试”设为 1  
2) “实验：失败一次”设为 `agent_product`  
3) 运行

观察：
- `t1` 失败后，所有依赖 `t1` 的任务被标记为 blocked（不会执行）

对应代码：
- blocked/deadlock 处理：`src/orchestrator/langgraph.ts` 里的 `dispatch`

---

## 实验 4：让某个角色“输出更结构化”

目标：理解 system prompt 对输出质量的影响。

打开 `src/agents/llmAgents.ts`，找到 `agent_frontend` 的 system prompt，追加硬性格式要求，比如：
- “输出必须包含：Architecture / API Contracts / Risks / TODOs（按这个顺序）”

重新运行页面，观察：
- 前端 agent 的输出是否变得更像“可执行方案”

---

## 实验 5：加一个新角色（新增一个 Worker）

目标：理解“多 Agent 分工是配置出来的”。

步骤（建议按顺序做）：
1) 在 `src/agents/llmAgents.ts` 里新增一个 `agent_security`（安全审查）  
2) 在 `src/agents/llmAgents.ts` 的 `AgentIdSchema` 里加入 `agent_security`  
3) 在 `createDefaultRoleAgents()` 里加一个新的 `LlmWorkerAgent(...)`  
4) 在 `src/agents/llmAgents.ts` 的 Planner system prompt 里，把 assignee 可选项也加上它  

运行后你会看到：
- Plan 可能会把某个任务分配给 `agent_security`
- 时间轴会多出一条 lane

---

## 实验 6（进阶）：把汇总从“拼字符串”升级为“结构化合并”

目标：把系统从 Demo 升级到工程可落地。

改造思路：
1) 要求 Worker 输出 JSON：`{ decisions, risks, nextActions }`
2) 用 zod 校验 Worker 输出
3) `agent_manager` 只做结构化合并，最后再渲染成 Markdown

你可以从这些文件入手：
- Worker 输出：`src/agents/llmAgents.ts`
- 汇总输出：`src/orchestrator/langgraph.ts` 的 `assembleFinal()`

