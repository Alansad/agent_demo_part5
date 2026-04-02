# Week 9–10 多 Agent 协作 Demo（TypeScript + Anthropic + LangGraph）

这是一份“可运行”的学习工程：用 **真实 LLM（Anthropic Messages API 兼容）** + **LangGraph.js（@langchain/langgraph）** 驱动 **主从 Agent**，把一个真实场景目标拆解为多任务，分发给不同角色（产品 / 前端 / 测试 / 文档 / 主控汇总）执行，最后统一汇总输出，并在 Web 页面里流式展示执行过程（Plan/时间轴/报告/Trace）。 

## 你将学会什么（对应 plan.md 的 Week 9–10）

1. 多Agent协作逻辑：为什么要分工、什么时候要并行、如何处理依赖与失败
2. 主从Agent分工：主Agent做规划（plan），从Agent做执行（do）
3. 任务分发 + 结果汇总：调度并发、超时、重试、汇总结构化输出

## 运行

1) 安装依赖

```bash
npm i
```

2) 配置环境变量（推荐用 `.env`）

```bash
cp .env.example .env
# 然后编辑 .env，填入：
# - ANTHROPIC_API_KEY
# - （可选）ANTHROPIC_AUTH_TOKEN（Bearer）
# - ANTHROPIC_MODEL
# （可选）ANTHROPIC_BASE_URL
```

常见场景：如果你使用“第三方 Anthropic 兼容网关”（例如火山方舟），通常需要设置 `ANTHROPIC_BASE_URL`；部分网关使用 Bearer 鉴权，则设置 `ANTHROPIC_AUTH_TOKEN`。

3) Web 页面演示（推荐，流式展示过程）

```bash
npm run web
```

打开终端输出的地址（默认 `http://127.0.0.1:8787`），在页面里点击“运行（流式）”即可看到：
- Planner 生成的任务计划（Plan）
- 多 Agent 结果泳道时间轴（实时更新）
- 最终报告（Final）
- Trace（调试事件流，实时更新）

4) CLI 运行（可选，默认场景：`frontend-agent-mvp`）

```bash
npm run dev
```

想换场景（可选）：

```bash
npm run dev -- --scenario ecommerce-feature
npm run dev -- --scenario design-system
npm run dev -- --listScenarios true
```

排查网关兼容性（推荐先打开）：

```bash
# CLI 模式开启调试日志
npm run dev -- --debug true

# 或者用环境变量
LLM_DEBUG=true npm run dev
```

## 技术方案（详细）

### 1) 设计目标

- **真实 LLM 驱动**：主 Agent 生成“动态任务计划”，而不是写死任务列表。
- **框架化编排**：用 `@langchain/langgraph` 承担任务编排/并发调度/状态汇聚，避免手写调度器。
- **工程可用**：计划与结果都有稳定的数据契约（schema），有失败处理、可观测性（trace），并能落盘给前端做可视化。

非目标（当前 Demo 暂不做）：

- 不做 RAG/知识库检索，不做长期记忆（只做一次性规划 + 执行）。
- 不做浏览器/文件系统等复杂工具链（先把多 Agent 协作骨架搭稳）。

### 2) 总体架构

从“输入目标”到“最终报告”的流水线：

1. **输入**：`goal` + `scenario`（真实场景提示词模板）
2. **规划（Planner / Master Agent）**：LLM 输出结构化 `TaskSpec[]`
3. **编排（LangGraph StateGraph）**：
   - 依据依赖关系挑选可运行任务
   - 并发执行 Worker 节点
   - 聚合 `TaskResult[]` 与 `TraceEvent[]`
4. **执行（Worker Agents）**：不同角色（产品/前端/测试/文档/主控）分别产出结果
5. **汇总**：输出最终可读报告 + trace（可落盘）

```text
goal/scenario
   │
   ▼
LLM Planner  ──(TaskSpec[])──▶  LangGraph(StateGraph)
                                   │   ▲
                                   │   │ (results/trace reducers)
                          Send(run_task) │
                                   ▼   │
                            Worker Agents (LLM)
                                   │
                                   ▼
                           Final Report + Trace
```

### 3) 关键依赖（尽量不手写）

- **Anthropic SDK**：`@anthropic-ai/sdk`（真实模型调用）
- **LangGraph.js**：`@langchain/langgraph`（编排框架：状态机/并发 dispatch/汇聚）
- **Zod**：`zod`（Planner 输出 JSON schema 校验）
- **dotenv**：自动加载 `.env`
- **p-retry / p-timeout**：节点内部的重试与超时（避免自己写）
- **Express**：Web Demo API（含 SSE 流式）

### 4) 数据契约（你需要“死记硬背”的部分）

这三类结构决定了系统是否工程可扩展：

- `TaskSpec`：任务是什么、谁执行、依赖谁
- `TaskResult`：执行产物（成功/失败、耗时、输出与 artifacts）
- `TraceEvent`：可观测性事件流（启动/计划/任务开始/成功/失败/最终汇总）

这些类型集中在 `src/types.ts`。

### 5) 动态任务规划（Master Agent）

规划器实现：`src/agents/llmAgents.ts` 的 `LlmPlanner.createPlan()`。

核心做法：

- 用 system prompt 强约束输出为 **纯 JSON**（避免 Markdown/自然语言污染）。
- 用 `zod` 对 JSON 做 schema 校验（字段缺失/类型不对直接 fail fast）。
- 对 plan 做额外验证：
  - `id` 不重复
  - `dependsOn` 引用存在
  - 无依赖环（cycle）
- 强制要求 plan 里必须包含 `agent_manager` 的最终汇总任务（让输出形成闭环）。

真实场景来源：

- `src/scenarios.ts` 提供多个“像真实项目”的 prompt 模板（例如电商优惠券、组件库、前端学习 Agent MVP）。

### 6) 编排与并发（LangGraph StateGraph）

编排实现：`src/orchestrator/langgraph.ts` 的 `runWithLangGraph()`。

状态（State）核心字段：

- `tasks: TaskSpec[]`：全量任务列表
- `task?: TaskSpec`：被 `Send("run_task", { task })` 分发给 worker 的“单任务输入”
- `results: TaskResult[]`：通过 reducer 追加聚合
- `completed: string[]`：已完成任务 id 集合（也用 reducer 聚合去重）
- `trace: TraceEvent[]`：事件流（可落盘、可视化）

图（Graph）节点设计：

- `dispatch`：负责“阻塞任务判定”（依赖失败则标记 blocked）并触发路由
- `run_task`：真正执行一个任务（调用对应的 LLM Worker Agent）
- 条件边（Conditional Edges）：
  - 若全部完成 → `END`
  - 否则对所有 runnable 任务返回 `Send("run_task", state+task)`，LangGraph 负责并发调度（避免丢失 state 字段）

并发控制：

- 在 `graph.invoke(..., { maxConcurrency })` 里用 `--concurrency` 控制最大并发（LangGraph runtime 执行）。

### 7) 可靠性策略（失败处理/重试/超时）

每个任务的执行遵循：

- **超时**：`p-timeout` 包裹 `agent.run(...)`
- **重试**：`p-retry` 处理（次数来自 `--maxAttempts`，退避来自 `--backoffMs`）
- **依赖失败传播**：如果 A 失败，则依赖 A 的任务会被标记为 `Blocked by failed dependency`
- **未知 agent**：计划里出现未知 `assignee` 会直接失败并进入汇总

### 8) 可观测性与可视化（Trace）

- Web 模式：通过 SSE 流式推送 `plan/task_result/trace/final`，前端实时渲染
- CLI 模式：
  - `--traceFile trace.json`：落盘 trace
  - `--outputFile report.md`：落盘最终报告（附 raw results）
  - `--viz true`：额外输出一个 CLI 版“简单泳道”

进阶（后续可做）：

- 用 LangGraph 的 `streamMode: ["tasks","debug","values"]` 做更细的实时可视化与调试面板。

### 9) 配置与安全

- 复制 `.env.example` → `.env`，填 `ANTHROPIC_API_KEY/ANTHROPIC_MODEL` 等
- 如网关使用 Bearer：填 `ANTHROPIC_AUTH_TOKEN`
- `.env` 已在 `.gitignore` 中忽略，避免密钥提交
- CLI 参数可覆盖环境变量（便于 CI 或多环境切换）

### 9.1 Web Demo（流式）实现说明

- 服务端入口：`src/server.ts`
  - `POST /api/run/stream`：SSE 流式输出（`meta/phase/plan/task_result/trace/final/done`）
  - 静态页面：`public/`
- 前端入口：`public/app.js`
  - 使用 `fetch + ReadableStream` 解析 SSE，边收到事件边更新 UI

### 10) 扩展点（从 Demo 到“能落地”）

推荐的演进顺序：

1. **结构化 artifacts**：让 Worker 输出 `{ decisions, risks, nextActions }`（JSON schema），汇总改为结构化合并。
2. **Judge/Evaluator**：加一个裁判 Agent，对子结果打分，低分自动触发重试/补充任务。
3. **工具调用（Tools）**：引入 web/文件/代码分析等工具，把 Worker 从“写方案”升级为“做事”。
4. **多轮规划（Iterative Planning）**：Planner 先粗拆，跑一轮后根据结果二次拆分（LangGraph 很适合）。

## 下一步练习（建议你自己动手）

- 调整 `--maxTasks` 与 `--concurrency`，观察 trace（并行/依赖）的变化
- 新增一个场景：在 `src/scenarios.ts` 里加一个 `SCENARIOS` 项
- 让 Planner 强制输出更“结构化”的 artifacts（JSON），再升级汇总逻辑为“结构化合并”

更系统的讲解见 `docs/week9-10-multi-agent.md`。
