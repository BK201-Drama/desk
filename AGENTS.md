# 工具

- `npm run arch`：dependency-cruiser，规则在 `.dependency-cruiser.cjs`。
- `npm run gate`：先 `arch`，再 `npm run test:e2e`，报告写到 `gate-report.json`。
- 对话结束时，工作区钩子 `.cursor/hooks/desk-arch.mjs` 会跑 `npm run arch`，失败则把原文送回代理。
