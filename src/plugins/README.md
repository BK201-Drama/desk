# Bundled 插件（L2）

## 加一个插件（固定步骤）

1. 复制 `_template/` 为 `plugins/<id>/`（目录名 = `manifest.id`）
2. 改 `manifest.json`（id / name / slot / permissions / order）
3. 在 `panel.tsx`（及可选 `panel.css` / `model.ts`）写完 UI 与逻辑
4. 若需本机能力：加 Rust command，并在 `host/api.ts` 的 `PERM_COMMANDS` 映射权限
5. 用命令面板或 `plugins.json` 启用（新 id 默认启用，除非写进某预设的 disabled）

**不必改** `plugins/index.ts`（Vite `import.meta.glob` 自动发现）。

## 强制约定（新插件）

| 做 | 不做 |
|----|------|
| 一切放在 `plugins/<id>/` | 新建 `domain/*`、`application/*`、`features/*` |
| 需要 normalize 就写同目录 `model.ts` | 为新面板再迁一层 DDD |
| 只依赖 `host/types`（及 SDK 未来面） | `import` 其它插件内部 |

`_` 开头目录（如 `_template`）不会被加载。

## 旧面板

现有 github / fence 等仍可能 `panel.tsx` → `features/` 转发；**维持即可**。大改某个旧面板时再收进自包含目录。

## Manifest

见仓库文档 `opc-doc/products/009-desk/specs/2026-08-29-plugin-l2-cheap-path.md` 与 `2026-08-28-plugin-host.md`。
