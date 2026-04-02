export type Scenario = {
  id: string;
  title: string;
  prompt: string;
};

export const SCENARIOS: Scenario[] = [
  {
    id: "frontend-agent-mvp",
    title: "前端学习 Agent（产品化 MVP）",
    prompt: [
      "你要做一个“前端学习 Agent”产品的 MVP（可用于作品集/面试）。",
      "它要支持：学习目标输入 → 自动拆解学习任务 → 生成可执行周计划 → 输出验收标准 → 复盘总结。",
      "同时要有：多 Agent 协作（产品/前端/测试/文档/主控汇总），并能输出 trace 供前端可视化。",
      "请把目标当成真实工程项目对待，给出可交付计划。",
    ].join("\n"),
  },
  {
    id: "ecommerce-feature",
    title: "电商优惠券功能（真实业务）",
    prompt: [
      "你要给一个电商网站新增“优惠券”功能（Web + H5）。",
      "要求：领取/核销、叠加规则、灰度、埋点、异常兜底、回滚方案。",
      "假设后端已有基础接口，但前端需要完整方案、验收与测试计划。",
      "请按真实上线项目给出计划与交付物。",
    ].join("\n"),
  },
  {
    id: "design-system",
    title: "组件库/Design System（工程化）",
    prompt: [
      "你要在公司内部从 0 到 1 搭一个 Design System：组件库 + 规范 + 文档站 + 发布流程。",
      "要求：TypeScript、lint/format、CI、版本管理、变更日志、示例与可访问性。",
      "请按真实工程方案给出任务分解与里程碑。",
    ].join("\n"),
  },
];

export function findScenario(id: string | undefined): Scenario | undefined {
  if (!id) return undefined;
  return SCENARIOS.find((s) => s.id === id);
}

