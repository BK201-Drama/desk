# Bundled 插件

## 加一个插件

1. 复制 `_template/` → `plugins/<id>/`（目录名 = `manifest.id`）
2. 改 `manifest.json`，在同目录写完 UI / hook / model / css
3. 若需本机能力：Rust command + `host/api.ts` `PERM_COMMANDS`
4. 布局启用

**不必改** `plugins/index.ts`（`import.meta.glob` 自动发现）。`_` 前缀目录不加载。

## 约定

| 做 | 不做 |
|----|------|
| 一切放在 `plugins/<id>/` | 再建 `domain/` / `application/` / `features/` |
| 跨插件工具放 `src/lib/` | `window.__desk*` 暗桥 |
| 跨面板动作用 `DeskShellProvider` | 宿主 import 面板内部实现 |

## 架构

见 `opc-doc/products/009-desk/specs/2026-08-29-l3-thin-host.md`。
