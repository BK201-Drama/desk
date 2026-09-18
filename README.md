# desk

Windows 桌面玻璃看板 —— 把常用信息与桌面图标收进一块常驻底栏。

用 **Tauri 2 + WebView2** 做透明置底窗口：GitHub 贡献、本地 Multica 看板、待办、QQ 音乐卡片，以及**真桌面**图标围栏。面板可热插拔，布局可一键切换；支持**日间 / 夜间**外观（夜间玻璃更透，壁纸色会渗进板子）。

<p align="center">
  <img src="docs/screenshots/00-desktop.png" alt="desk on desktop (night)" width="720" />
</p>

<p align="center">
  <img src="docs/screenshots/01-board.png" alt="desk board night" width="320" />
  &nbsp;
  <img src="docs/screenshots/02-cmdk.png" alt="command palette night" width="320" />
</p>

## 功能

- **围栏**：真桌面图标**原地不动**，desk 只读索引 + 监听变化；分类展示、搜索、最近启动，图标可拖到别的分类，分类可点标题收起、可右键调高度
- **GitHub**：贡献热力、置顶仓库、语言占比（token 只存本机）
- **Multica**：读本地看板摘要（需本机 Multica 在跑）
- **待办**：轻量提醒列表
- **QQ 音乐**：系统媒体会话 + 多媒体键播控；点封面拉前台
- **系统资源**：内存/CPU 环 + Top 应用（默认关，命令面板启用）
- **布局预设**：程序员 / 极简 / 仅围栏 / 方案（启停 + **顺序**）
- **日间 / 夜间**：命令面板「外观 → 夜间模式」开关；偏好记在本机，不跟随 Windows 深色模式
- **命令面板**：全局快捷键打开；插件与夜间模式用 switch；↑↓ 调插件顺序；编辑态可拖拽左栏

## 环境

- Windows 10/11 + WebView2
- Node.js 18+、Rust（[Tauri 前置](https://v2.tauri.app/start/prerequisites/)）

## 开发

```bash
npm install
npm run tauri:dev
```

## 构建

```bash
npm run tauri build
```

产物大致在：

- `src-tauri/target/release/desk.exe`
- `src-tauri/target/release/bundle/nsis/` 或 `msi/`

安装或运行 release 后可开开机自启；板内可随时关掉。

## 快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+Shift+K` / `Win+Shift+K` | 命令面板 |
| `Win+Shift+D` | 编辑模式 —— **用于左栏插件拖拽重排**；对围栏只剩「点图标是否启动」一道闸，拖拽图标不需要它 |
| `/` | 展开围栏搜索并聚焦（点顶栏搜索图标同效） |

desk 置底时普通 `Ctrl+K` 常收不到，所以用带 `Shift` 的全局热键。

**围栏的三个鼠标动作**（不需要任何热键）：

| 动作 | 效果 |
|------|------|
| 按住图标拖到另一栏 | 改分类，落点会高亮 |
| 点分类标题 | 整栏收起 / 展开（重启后保持） |
| 右键分类标题 → 高度 | 自动 / 1–5 行（内容超出可滚动） |

看板**始终可点击** —— 没有「鼠标穿透」状态；编辑模式的主用途是左栏插件重排，对围栏只决定点图标开不开程序。

## 插件

看板由插件填充左右栏与 overlay。

**加一个内置面板（L2）：** 复制 `src/plugins/_template/` → `src/plugins/<id>/`，改 manifest 与 `panel.tsx` 即可（`plugins/index.ts` 用 glob 自动发现，不必改注册表）。新面板逻辑放在插件目录内，不要再开 `domain/` / `application/` / `features/`。说明见 `src/plugins/README.md`。

**用户插件目录：** `%LOCALAPPDATA%\desk\plugins\<id>\`

```
manifest.json
panel.js      # ESM：export default { mount, unmount? }
panel.css     # 可选
```

启用列表：`%LOCALAPPDATA%\desk\plugins.json`。

> 插件等于本机代码，不要加载不可信目录。

## 配置与隐私

敏感信息**不会**进仓库，只落在本机：

| 文件 | 用途 |
|------|------|
| `%LOCALAPPDATA%\desk\github.json` | GitHub token（也可 `gh auth` / 环境变量） |
| `%LOCALAPPDATA%\desk\multica.json` | Multica API token |
| `%LOCALAPPDATA%\desk\plugins.json` | 布局与禁用列表 |
| `%LOCALAPPDATA%\desk\fence.json` | 围栏归属、排序与显示偏好（**只有元数据，不含文件**） |
| `%LOCALAPPDATA%\desk\icons\` | 图标缓存（PNG，删了会自动重抽） |
| `%LOCALAPPDATA%\desk\reminders.json` | 待办 |

## 围栏与系统状态

围栏**不搬动任何文件**。桌面（用户 + 公共）是唯一真相源，desk 只读它、并监听它的变化：
真桌面新建 / 改名 / 删除，看板 1 秒内跟着变。图标属于哪个分类、分类是否收起、几行高，
全部记在 `fence.json`；删掉它只会丢偏好，**永远不会丢文件**。

desk 运行期间会置 `HideIcons = 1` 收起 Windows 桌面图标（桌面改由看板呈现），
这个状态**绑进程**：

- 正常退出（托盘退出 / 关窗）→ 自动恢复
- 卸载 → 删除该注册表值，回到「从未设置过」的出厂状态
- 被强杀 / 崩溃 → 桌面图标可能留着不收，命令面板（`Ctrl+Shift+K`）搜**桌面图标**可一键救回

> 历史：早期版本会把桌面文件搬进 `%LOCALAPPDATA%\desk\vault\`。这个模型已经废弃，
> 34 个文件已全部搬回真桌面。`vault/` 现在是空的，`vault.json.migrated` 是迁移前的原始账本
> （改名保留），旁边还有几个 `vault.json.bak-*` 备份 —— **都别删**，它们是那次不可逆操作的唯一回滚依据。

## 说明

- desk 是本机桌面窗，不是服务，不适合 Docker 跑
- Multica / GitHub 连不上时对应面板会降级提示，不影响围栏

## License

MIT
