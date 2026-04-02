# Week 9–10：多 Agent 协作（教学版）

目标：你能用前端工程师熟悉的“状态管理 + 异步编排 + 调度器”的思维，把一个 Agent 进化为“多 Agent 系统”。

## 1. 多 Agent 解决什么问题？

单 Agent 的瓶颈通常不是“写不出代码”，而是：

- 同时要做规划、执行、校验，容易自我确认偏差
- 任务变复杂后，单线程式思考会拖慢整体吞吐
- 缺少“不同视角”：产品/工程/测试的约束不同

多 Agent 的价值：**把复杂问题拆成可并行的子问题**，用“不同角色”交叉校验，最后由主 Agent 汇总。

## 2. 主从 Agent（Master–Worker）分工模型

把 Agent 当成组件，你可以用 2 个最小接口把系统搭起来：

- Master（主 Agent）：输入 goal → 输出 plan（任务列表、依赖、指派）
- Worker（从 Agent）：输入 task + 上下文 → 输出 result（可结构化 artifacts）

这和前端的关系非常像：

- Master = Router/State Machine（负责流程控制）
- Worker = Action/Effect（负责执行副作用）
- Orchestrator = Redux-Saga/React Query（负责调度、重试、并发、超时）

## 3. 任务分发：调度器需要哪些能力？

最小可用调度器/编排器（本仓库 `src/orchestrator/langgraph.ts`）实现了：

1) 依赖控制：任务 B dependsOn A → A 成功前 B 不启动  
2) 并发控制：`concurrency` 决定同时跑几个任务  
3) 超时：`taskTimeoutMs` 到点直接失败  
4) 重试：失败后最多 `maxAttempts` 次，带 `backoffMs` 退避  
5) 死锁保护：依赖失败导致永远无法启动的任务，会被标记为失败（Blocked）

这些能力对应工程实践里的“可靠性”。

## 3.2 为什么这里说“工程能力”更重要？

多 Agent 不是“多开几个聊天窗口”，而是把工程里成熟的能力搬进来：

- **数据契约**：TaskSpec/TaskResult/TraceEvent（可序列化、可回放）
- **结构化输出校验**：Planner 输出用 `zod` 校验（避免“看起来像 JSON”但不可用）
- **可靠性策略**：并发、超时、重试、死锁保护
- **可观测性**：TraceEvent 可落盘，前端可视化复盘

本仓库的实现选择：

- 编排/调度：`@langchain/langgraph`（StateGraph + Send 做 dispatch）
- 重试/超时：节点内部使用 `p-retry` / `p-timeout`（避免手写）

## 3.1 在代码里分别对应哪里？

- 主Agent（规划器）：`src/agents/llmAgents.ts` 里的 `LlmPlanner.createPlan()`
- 从Agent（执行器）：`src/agents/llmAgents.ts` 里的 `LlmWorkerAgent`
- 主控汇总Agent（可选）：同上（`agent_manager` 角色）
- 调度器/编排器：`src/orchestrator/langgraph.ts` 的 `runWithLangGraph()`
- 数据契约：`src/types.ts`（TaskSpec/TaskResult/TraceEvent）
- CLI 入口：`src/index.ts`（参数、落盘、简单泳道）

## 3.3 真实 LLM（Anthropic）怎么接入？

本仓库用 Anthropic 官方 SDK 调用 Messages API：

- 客户端：`src/llm/anthropic.ts`（`import Anthropic from "@anthropic-ai/sdk"`）
- 你需要提供：
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_MODEL`
  - 可选：`ANTHROPIC_BASE_URL`（自建网关/代理）

CLI 也支持覆盖：`--apiKey` / `--apiUrl` / `--model`。

## 3.4 “不要写死任务”怎么做到？

关键是：**任务计划由 LLM 生成**，而不是写在代码里。

- 规划器：`LlmPlanner.createPlan()` 会让模型按 JSON schema 输出 `tasks`
- 校验：用 `zod` 校验 schema + 检查依赖/环（避免不可执行计划）
- 执行：调度器只认 `TaskSpec[]`（它不关心任务内容是什么）

这就是把“业务变化”隔离在 plan 层的工程做法。

## 4. 结果汇总：怎么把一堆输出变成“可用结论”？

汇总不是拼接字符串，而是做三件事：

1) 对齐：每个任务输出对齐到同一个目标（goal）  
2) 去重：不同 Agent 重复的内容去掉  
3) 冲突处理：当建议冲突时，给出决策规则（例如以验收标准优先）

本仓库 Demo 先实现“可读的合并”，下一步你可以升级为“结构化合并”：

- 每个 Worker 输出 `{ decisions, risks, nextActions }`
- 主 Agent 以 JSON schema 输出 `finalReport`

## 5. 建议你照着做的 3 个练习

### 练习 A：加一个“裁判 Agent”

新增一个 `JudgeAgent`：

- 输入：某个任务的 result
- 输出：评分（0-10）+ 是否需要重试 + 需要补充的问题

把它接进 orchestrator：当评分 < 7 → 自动触发重试（或生成新任务）。

## 6. 你接入真实 LLM 时，最关键的 2 个点

1) **让 Master 输出结构化计划**  
建议强制 Master 产出 JSON（比如 `{ tasks: TaskSpec[] }`），否则解析会很痛苦。

2) **让 Worker 输出结构化 artifacts**  
不要只输出自然语言；至少输出 `{ decisions, risks, nextActions }`，汇总会简单很多。

### 练习 B：让 Master 真正“动态规划”

把 `MasterAgent.createPlan()` 从固定数组，升级为：

- 先输出高层任务
- 执行一轮后，基于 resultsSoFar 再拆细（第二轮 tasks）

这就是“分层规划 / 迭代规划”。

### 练习 C：做前端可视化

用 `TraceEvent` 在前端画一张图：

- x 轴时间
- y 轴 Agent（泳道）
- 每个 task 画成一个块（start/end）

你会立刻理解并发、依赖、重试对系统的影响。

提示：CLI 支持把 trace 落盘，直接生成 `trace.json`：

```bash
npm run dev -- --traceFile trace.json
```
