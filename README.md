# desk

Windows 桌面看板（Tauri 2）· OPC 产品 `009-desk`

> desk 是 **本机 Win32 + WebView2** 透明窗，不是服务。不适合 Docker 跑（没有桌面 Shell / 围栏 / toast）。本地 Multica 才是 Docker/自托管；desk 只读它的 API。

## 开发

```bash
cd opc-project/desk
npm install
npm run tauri dev
```

## 发布安装包（含开机自启）

```bash
npm run tauri build
```

产物大致在：

- `src-tauri/target/release/desk.exe`
- `src-tauri/target/release/bundle/nsis/` 或 `msi/`

安装或直接跑 **release** 的 `desk.exe` 后，默认写入 Windows 登录自启。右上角 **自启开/关** 可切换；关掉会留下 `%LOCALAPPDATA%\desk\autostart-off`，避免下次又被打开。

> `tauri dev` 调试进程也可以注册自启，但不推荐：自启应指向 release 安装路径。先 `tauri build` / 安装，再开自启。

## 内存 / 启动

已做：

- 去掉 Google Fonts 外链（改 Segoe / Cascadia）
- 启动先围栏+待办，GitHub / Multica 延迟拉取
- `withGlobalTauri: false`、任务栏隐藏
- release：`lto` + `opt-level=s` + `strip`

WebView2 本身仍有底噪；要再压只能更晚加载远程图、或缩小窗口。

## 围栏接管（桌面图标）

启动后会：

1. 清空**用户桌面 + 公共桌面**上的**全部**项目（文件、快捷方式、文件夹；仅留 desktop.ini）
2. 移入 vault（`%LOCALAPPDATA%\desk\vault`），在围栏里展示
3. 打开 `HideIcons`，隐藏回收站等系统桌面图标
4. 双击围栏内图标启动；编辑态可拖排序

右上角 **还原**：全部移回并取消 HideIcons。

## 文档

- 规格：`opc-doc/products/009-desk/specs/2026-08-16-desk-design.md`
- 计划：`opc-doc/products/009-desk/plans/2026-08-16-desk-mvp.md`
- 视觉参考：`novel/desk_widget_mock.html`
