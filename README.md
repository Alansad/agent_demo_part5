# Week 9–10 多 Agent 协作 Demo（TypeScript + Anthropic）

这是一份“可运行”的学习工程：用 **真实 LLM（Anthropic Messages API）** 驱动 **主从 Agent**，把一个真实场景目标拆解为多任务，分发给不同角色（产品 / 前端 / 测试 / 文档 / 主控汇总）执行，最后统一汇总输出，并附带一份可用于前端可视化的 `TraceEvent`。

## 你将学会什么（对应 plan.md 的 Week 9–10）

1. 多Agent协作逻辑：为什么要分工、什么时候要并行、如何处理依赖与失败
2. 主从Agent分工：主Agent做规划（plan），从Agent做执行（do）
3. 任务分发 + 结果汇总：调度并发、超时、重试、汇总结构化输出

## 运行

1) 安装依赖

```bash
npm i
```

2) 配置 Anthropic（任选其一）

- 环境变量：
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_MODEL`（例如 `claude-3-5-sonnet-latest`，以你实际可用为准）
  - 可选：`ANTHROPIC_BASE_URL`（自建网关/代理时）
  - 可选：`ANTHROPIC_VERSION`

也可以直接编辑项目根目录的 `.env`（已提供模板）。

3) 跑 Demo（选择一个真实场景）

```bash
npm run dev -- --listScenarios true
npm run dev -- --scenario frontend-agent-mvp --concurrency 2 --trace true
```

你会看到：
- 任务执行汇总（成功/失败、耗时）
- 每个 Agent 的输出
- TraceEvent JSON（可直接给前端画时间轴/泳道图）

常用参数：

```bash
# 覆盖 LLM 配置（也可用环境变量）
npm run dev -- --apiKey "$ANTHROPIC_API_KEY" --apiUrl "https://api.anthropic.com" --model "$ANTHROPIC_MODEL"

# 控制计划规模与并发
npm run dev -- --maxTasks 8 --concurrency 3

# 把 trace 和报告写入文件，便于前端可视化
npm run dev -- --traceFile trace.json --outputFile report.md --viz true
```

## 下一步练习（建议你自己动手）

- 调整 `--maxTasks` 与 `--concurrency`，观察 trace（并行/依赖）的变化
- 新增一个场景：在 `src/scenarios.ts` 里加一个 `SCENARIOS` 项
- 让 Planner 强制输出更“结构化”的 artifacts（JSON），再升级汇总逻辑为“结构化合并”

更系统的讲解见 `docs/week9-10-multi-agent.md`。
