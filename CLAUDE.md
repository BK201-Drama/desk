# 工具

架构门禁是已安装的 dependency-cruiser，不是一段提示。

- `npm run arch`：按 `.dependency-cruiser.cjs` 扫描 `src`。插件不能互引，`lib` 不能引 `plugins` 或 `app`，`host` 的非测试代码不能引 `plugins` 或 `app`。失败则退出码 1，并打印规则名和文件。
- `npm run gate`：先跑 `npm run arch`，通过后再跑已有的 `npm run test:e2e`。结果写在 `gate-report.json`。

Cursor 在本工作区结束一轮代理时，`.cursor/hooks/desk-arch.mjs` 会执行 `npm run arch`。失败则把扫描原文送回代理再改，最多 3 次。
