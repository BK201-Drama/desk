import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PluginComponentProps } from "../../host/types";
import { isTextField } from "../../host/util";
import { setEditing, toggleEditing } from "../../host/edit";
import { useKeyboardInput } from "../../lib/useKeyboardInput";
import { useDeskShellOptional } from "../../app/providers/DeskShellProvider";
import { useFences } from "./useFences";
import { findItemById, searchFences, totalFenceItems, type FenceItem } from "./model";
import { fenceIconStyle, highlightLabelParts } from "./iconStyle";
import { useFenceDnD } from "./useFenceDnD";
import { useRecents, RecentRow } from "./recent";
import { FenceContextMenu, useMenuIo } from "./FenceContextMenu";
import { useFenceDialogs } from "./FenceDialog";
import { targetFor, type MenuTarget } from "./contextMenuModel";

function AppButton({
  ctx,
  item,
  dragging,
  onPointerDown,
  onLaunch,
  extraClass,
}: {
  ctx: PluginComponentProps["ctx"];
  item: FenceItem;
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onLaunch: () => void;
  extraClass?: string;
}) {
  return (
    <button
      type="button"
      className={`fence-app${dragging ? " dragging" : ""}${extraClass ?? ""}`}
      data-id={item.id}
      data-path={item.path}
      title={item.label}
      onPointerDown={onPointerDown}
      onClick={onLaunch}
    >
      <div className="face" style={fenceIconStyle(ctx, item.icon, item.label)} />
      <span className="label">{item.label}</span>
    </button>
  );
}

export function FencePanel({ ctx }: PluginComponentProps) {
  const shell = useDeskShellOptional();
  const setKeyboard = useKeyboardInput(ctx);
  const { fences, loadError, loadFences, persistOrder, launch } = useFences(ctx);
  const { items: recents, push: pushRecent } = useRecents(ctx, fences);
  const { draggingId, onAppPointerDown, consumeSuppressClick } = useFenceDnD(
    ctx,
    fences,
    persistOrder
  );
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(-1);
  const [autostartOn, setAutostartOn] = useState(false);
  const [iconsVisible, setIconsVisible] = useState(true);
  const [iconsError, setIconsError] = useState<string | null>(null);
  const [editingOn, setEditingOn] = useState(() => ctx.editing());
  /** 打开中的右键菜单。`at` 是打开那一刻的指针位置（屏幕像素）。 */
  const [menu, setMenu] = useState<{ target: MenuTarget; at: { x: number; y: number } } | null>(
    null
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = filter.trim().toLowerCase();
  const hits = searchFences(fences, filter);
  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const total = totalFenceItems(fences);

  /**
   * 启动的**唯一入口**：真正打开 + 记入最近。
   * 鼠标点击、搜索结果、键盘回车三条路径都必须走这里，
   * 否则就会出现「某条路径启动的东西不进最近」这种只在某一条路上复现的怪 bug。
   *
   * `ctx.editing()` 那道闸是**故意的**，不是多余：编辑态下点击是用来拖拽排序的，
   * 东西根本没被打开，自然不该进最近。旧代码把这道闸放在 `launch` 里，
   * 而 `launch` 现在不再管最近，所以这里必须自己挡一次。
   *
   * 定义必须**早于**下面那个键盘 useEffect —— 它出现在依赖数组里，
   * 而依赖数组是在渲染期求值的，晚定义会踩 `const` 的 TDZ。
   */
  /**
   * 「菜单现在开着吗」。给搜索框的 `onBlur` 用 —— 见那一处注释。
   * 与上面的 ref 们一样在渲染期同步，读取者都是事件回调，不在渲染期读。
   */
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu !== null;

  const doLaunch = useCallback(
    (path: string, id?: string) => {
      if (ctx.editing()) return;
      launch(path, id);
      if (id) pushRecent(id);
    },
    [ctx, launch, pushRecent]
  );

  /**
   * 弹窗：`dialog.prompt / confirm / alert` 是 `await` 一个答案的命令通道，
   * `node` 是它的渲染出口（必须挂在下面面板根里，理由见 `FenceDialog.tsx`）。
   *
   * 这里**不再有** `withKeyboard(fn)` 那个包装 —— 键盘租约搬进了弹窗自己：
   * 「租约到手才渲染」比「租约到手再弹原生框」更严。完整因果（以及为什么非得
   * 借键盘不可）写在 `FenceDialog.tsx` 文件头，这里只留一句路标。
   */
  const { dialog, node: dialogNode } = useFenceDialogs(setKeyboard);

  // 菜单的命令通道。`open` 接的就是上面那个 doLaunch —— 于是「从右键菜单打开」
  // 与「点图标打开」走的是同一条路（含「记进最近」）。
  const menuIo = useMenuIo(ctx, doLaunch, dialog);
  /**
   * 关菜单**并还键盘**。
   *
   * 菜单开着的时候键盘租约在我们手上（见 `onContextMenu`），关掉就该还 ——
   * 不还的话看板从此变成「点一下就把焦点从别的程序抢过来」的窗口，而那正是它
   * 一开始就被设计成不做的事。
   *
   * 与「选中一项后弹窗」不冲突：`pick()` 是**先关菜单、再跑动作**
   * （`FenceContextMenu.tsx` 的 `pick`），而弹窗在挂载时自己会再借一次
   * （`FenceDialog.tsx` 的租约 effect）。两次 IPC 有先后无重叠，最后落在「借」上。
   */
  const closeMenu = useCallback(() => {
    setMenu(null);
    if (!isTextField(document.activeElement)) void setKeyboard(false);
  }, [setKeyboard]);

  useEffect(() => {
    const host = document.querySelector<HTMLElement>('[data-plugin="fence"]');
    host?.classList.add("pane-fences");
    setEditing(false);
    const unsubs = [
      ctx.onEditChange((on) => {
        setEditingOn(on);
        if (on && filterRef.current) {
          setFilter("");
          setSelected(-1);
        }
      }),
      ctx.registerCommand({
        id: "restore",
        title: "还原图标到桌面",
        group: "围栏",
        // `run` 是同步签名，所以这里只能起一个 IIFE 把 `await` 关在里面。
        // 问句与按钮文字沿用原来的措辞，一个字没改 —— 换的是框，不是话。
        run: () => {
          void (async () => {
            if (!(await dialog.confirm({ title: "把图标还原回系统桌面？", okLabel: "还原" }))) return;
            try {
              await ctx.invoke("fence_restore");
              await loadFences();
            } catch (e) {
              await dialog.alert({ title: "还原失败", detail: String(e) });
            }
          })();
        },
      }),
      // 桌面推来新的一帧 → 关掉菜单。条目可能已经不在了（刚被删掉的那个），
      // 留着菜单就是留着一个**已经失效的 path**，下一次点击会拿它去发命令。
      ctx.on("fence:changed", () => setMenu(null)),
    ];
    const focusSearch = () => {
      void setKeyboard(true);
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    shell?.registerFocusFenceSearch(focusSearch);
    void ctx.invoke<boolean>("autostart_get").then(setAutostartOn).catch(() => {});
    // 读失败**不算**「图标已隐藏」—— 两者含义完全不同。分开存，
    // 否则一次 IPC 抖动会把按钮画成「已隐藏」，比不显示更误导。
    void ctx
      .invoke<boolean>("fence_icons_visible")
      .then(setIconsVisible)
      .catch((e) => setIconsError(String(e)));

    const keyHandler = (e: KeyboardEvent) => {
      const cmdkOpen = document.querySelector('[data-plugin="cmdk"].show');
      if (cmdkOpen) return;
      const active = document.activeElement;
      const inField = isTextField(active);
      const inSearch = active === searchRef.current;
      const curFilter = filterRef.current;
      const curHits = hitsRef.current;
      const curSelected = selectedRef.current;
      if (e.key === "/" && !inField) {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (e.key === "Escape") {
        if (curFilter.trim() || inSearch) {
          e.preventDefault();
          setFilter("");
          setSelected(-1);
          if (inSearch) (active as HTMLElement).blur();
        }
        return;
      }
      if (!curFilter.trim()) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!curHits.length) return;
        e.preventDefault();
        setSelected((s) => {
          if (e.key === "ArrowDown") return s < 0 ? 0 : Math.min(s + 1, curHits.length - 1);
          return s < 0 ? curHits.length - 1 : Math.max(s - 1, 0);
        });
        return;
      }
      if (e.key === "Enter" && curSelected >= 0 && (inSearch || !inField)) {
        const hit = curHits[curSelected];
        if (!hit) return;
        e.preventDefault();
        doLaunch(hit.item.path, hit.item.id);
      }
    };
    document.addEventListener("keydown", keyHandler);
    return () => {
      unsubs.forEach((u) => u());
      document.removeEventListener("keydown", keyHandler);
      shell?.registerFocusFenceSearch(null);
    };
  }, [ctx, doLaunch, dialog, launch, loadFences, setKeyboard, shell]);

  useEffect(() => {
    const host = document.querySelector<HTMLElement>('[data-plugin="fence"]');
    if (!host) return;
    host.classList.toggle("is-searching", Boolean(q));
    setSelected(q ? 0 : -1);
  }, [q]);

  const tryLaunch = (path: string, id?: string) => {
    if (consumeSuppressClick()) return;
    doLaunch(path, id);
  };

  const editHint = editingOn ? "完成 (Win+Shift+D)" : "编辑 (Win+Shift+D)";
  const lastCursor = useRef<string>("");

  return (
    <div
      ref={rootRef}
      className="fence-panel-root"
      data-testid="fence-panel"
      onContextMenu={(e) => {
        const t = e.target as HTMLElement | null;
        // 搜索框上的右键留给 WebView 原生菜单（剪切/粘贴/全选）。在输入框上盖一层
        // 「新建 ▸ / 粘贴」既没用，又把原生那几项弄没了。
        if (isTextField(t)) return;
        // WebView2 的默认右键菜单是**开着**的（wry 只透传、tauri 没暴露开关），
        // 不挡下来就会弹出 Edge 那套「重新加载 / 另存为 / 检查」。
        e.preventDefault();
        // 编辑态不开菜单：这个模式下左键是拖拽，`doLaunch` 那道 `ctx.editing()` 闸
        // 会让「打开」静默无操作 —— 与其给一个半死的菜单，不如让两种模式不重叠。
        if (editingOn) return;
        // 右键菜单是个**键盘**界面：Esc 要能关、重命名/删除要弹原生对话框。
        // 而这个窗口默认不可激活（`WS_EX_NOACTIVATE`），不先把键盘借过来，
        // 这两件事都会以「看得见、用不了」的方式失败（真机症状见 `withKeyboard`）。
        void setKeyboard(true);
        // 搜索结果行也是条目（带 data-id），一视同仁地给条目菜单；
        // 只有真正的空白（工具栏、围栏标题、网格空地）才出「新建 ▸ / 粘贴」。
        const host = t?.closest<HTMLElement>(".fence-app, .fence-search-row");
        const item = host?.dataset.id ? findItemById(fences, host.dataset.id) : null;
        setMenu({
          target: item ? targetFor(item) : { kind: "blank" },
          at: { x: e.clientX, y: e.clientY },
        });
      }}
      onPointerMove={(e) => {
        const t = (e.target as HTMLElement | null)?.closest<HTMLElement>(
          ".fence-app, .icon-btn, button, a, input, textarea, select, [role='button']"
        );
        let next = "default";
        if (t) {
          if (t.classList.contains("fence-app") && editingOn) {
            next = draggingId ? "grabbing" : "grab";
          } else {
            next = "pointer";
          }
        }
        if (next === lastCursor.current) return;
        lastCursor.current = next;
        void ctx.invoke("set_cursor", { icon: next }).catch(() => {});
      }}
      onPointerLeave={() => {
        lastCursor.current = "default";
        void ctx.invoke("set_cursor", { icon: "default" }).catch(() => {});
      }}
    >
      <div className="fences-toolbar">
        <div className="fences-head">
          <h2>
            全部图标{" "}
            <span style={{ fontWeight: 400, opacity: 0.6 }}>
              {q ? `· ${hits.length} 匹配` : `· ${total}`}
            </span>
          </h2>
          <div className="head-actions">
            <button
              type="button"
              className={`icon-btn${autostartOn ? " on" : ""}`}
              title={autostartOn ? "开机自启：开（点击关闭）" : "开机自启：关（点击开启）"}
              aria-label="开机自启"
              onClick={() => {
                void (async () => {
                  try {
                    const cur = await ctx.invoke<boolean>("autostart_get");
                    await ctx.invoke("autostart_set", { enabled: !cur });
                    setAutostartOn(!cur);
                  } catch (e) {
                    await dialog.alert({ title: "开机自启设置失败", detail: String(e) });
                  }
                })();
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 2.2v5.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <path
                  d="M5.05 4.35a4.2 4.2 0 1 0 5.9 0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="还原到系统桌面"
              aria-label="还原到系统桌面"
              onClick={() => {
                // 与工具栏上方那个 `registerCommand("restore")` 是**同一个动作**，
                // 措辞也一致。两处都在，是因为一个给命令面板、一个给按钮 ——
                // 别为了去重把其中一个删掉：命令面板里的那句是给人搜的。
                void (async () => {
                  if (!(await dialog.confirm({ title: "把图标还原回系统桌面？", okLabel: "还原" })))
                    return;
                  try {
                    await ctx.invoke("fence_restore");
                    await loadFences();
                  } catch (e) {
                    await dialog.alert({ title: "还原失败", detail: String(e) });
                  }
                })();
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4.2 6.2A4.2 4.2 0 1 1 3.8 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <path
                  d="M4.2 3.2v3.2H7.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="命令面板 (Ctrl+Shift+K)"
              aria-label="命令面板"
              onClick={() => shell?.openCmdk()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M3 4.5h10M3 8h7M3 11.5h10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              title={editHint}
              aria-label={editHint}
              onClick={() => toggleEditing()}
            >
              <svg className="ico-edit" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M10.6 3.1 12.9 5.4 6.2 12.1H3.9v-2.3L10.6 3.1z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M9.5 4.2 11.8 6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <svg className="ico-done" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M3.4 8.3 6.5 11.3 12.6 4.7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* 逃生口：崩溃/异常后一键把桌面图标要回来（spec §6.2 第 3 条）。
                刻意放最后，不动现有 4 个按钮的相对顺序。
                复用 .icon-btn / .icon-btn.on，本任务不新增任何样式。 */}
            <button
              type="button"
              className={`icon-btn${iconsVisible ? " on" : ""}`}
              title={
                iconsVisible ? "桌面图标：显示中（点击隐藏）" : "桌面图标：已隐藏（点击显示）"
              }
              aria-label="显示桌面图标"
              onClick={() => {
                void (async () => {
                  try {
                    const next = !iconsVisible;
                    await ctx.invoke("fence_set_icons_visible", { visible: next });
                    setIconsVisible(next);
                    setIconsError(null);
                  } catch (e) {
                    setIconsError(String(e));
                  }
                })();
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M1.6 8s2.4-4.2 6.4-4.2S14.4 8 14.4 8s-2.4 4.2-6.4 4.2S1.6 8 1.6 8z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.4" />
                {!iconsVisible ? (
                  <path
                    d="M3 13 13 3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                ) : null}
              </svg>
            </button>
          </div>
        </div>
        <input
          ref={searchRef}
          type="text"
          className="fence-search"
          placeholder="搜索图标…  /"
          autoComplete="off"
          spellCheck={false}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onPointerDown={(e) => {
            e.stopPropagation();
            void setKeyboard(true);
          }}
          onFocus={() => void setKeyboard(true)}
          onBlur={() => {
            window.setTimeout(() => {
              // `menuOpenRef` 那道闸不是防御性编程，是**时序**：右键一个搜索结果行时，
              // 浏览器会先让输入框失焦（本回调排进 0ms 定时器），随后才派发
              // contextmenu（那里借键盘）。这个定时器在**之后**才跑，不挡的话
              // 它会立刻把菜单刚借到的租约还掉 —— 菜单开着，Esc 与原生对话框又都失效了。
              if (!isTextField(document.activeElement) && !menuOpenRef.current) {
                void setKeyboard(false);
              }
            }, 0);
          }}
        />
      </div>

      {/* 桌面图标开关的读写失败提示。spec §8：HideIcons 写失败不许阻塞启动，
          所以失败以这条横条呈现，而不是把整个看板变成错误态。
          只有「读写这个开关本身出错」才显示 —— 图标正常处于隐藏态不是错误。 */}
      {iconsError ? (
        <div className="fence-warn" role="status">
          桌面图标开关读写失败：{iconsError}
        </div>
      ) : null}

      {q ? (
        <div className="fence-search-results">
          <div className="fence-search-panel">
            {!hits.length ? (
              <div className="fence-search-empty-wrap">
                <p className="fence-search-empty">无「{filter.trim()}」</p>
                <p className="fence-search-hint">试试英文名、拼音缩写或路径片段</p>
                <button
                  type="button"
                  className="fence-search-clear"
                  onClick={() => {
                    setFilter("");
                    setSelected(-1);
                    searchRef.current?.focus();
                  }}
                >
                  清除搜索
                </button>
              </div>
            ) : (
              <>
                <div className="fence-search-meta">
                  <span>{hits.length} 个结果</span>
                  <span className="fence-search-query">{filter.trim()}</span>
                </div>
                <div className="fence-search-list">
                  {hits.map((h, idx) => {
                    const parts = highlightLabelParts(h.item.label, q);
                    return (
                      <button
                        key={h.item.id}
                        type="button"
                        className={`fence-search-row${idx === selected ? " is-selected" : ""}`}
                        data-id={h.item.id}
                        data-path={h.item.path}
                        title={h.item.label}
                        onClick={() => tryLaunch(h.item.path, h.item.id)}
                      >
                        <div
                          className="face"
                          style={fenceIconStyle(ctx, h.item.icon, h.item.label)}
                        />
                        <div className="fence-search-row-text">
                          <span className="label">
                            {parts ? (
                              <>
                                {parts.before}
                                <mark>{parts.mid}</mark>
                                {parts.after}
                              </>
                            ) : (
                              h.item.label
                            )}
                          </span>
                          <span className="cat">{h.fence}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      <div id="fences" hidden={Boolean(q)}>
        {/* `!q` 留在面板这边（搜索时整块 #fences 是 hidden 的，不该再多渲染一个
            #fenceRecent）；「空则不渲染」在 RecentRow 内部。两个条件的归属不同，
            别顺手合并 —— 搜索态基线里 #fenceRecent 是**不存在**的。 */}
        {!q ? (
          <RecentRow ctx={ctx} items={recents} onLaunch={(i) => tryLaunch(i.path, i.id)} />
        ) : null}
        {loadError ? (
          <div className="fence">
            <div className="fence-title">围栏</div>
            <p style={{ fontSize: 11, color: "#6b7a8c", padding: 4 }}>
              无法接管桌面：{loadError}
            </p>
          </div>
        ) : (
          fences.map((f) => (
            <div key={f.name} className="fence" data-name={f.name}>
              <div className="fence-title" aria-label={`${f.name} ${f.items.length}`}>
                {f.name} <em>{f.items.length}</em>
              </div>
              <div className="fence-grid">
                {f.items.map((item) => (
                  <AppButton
                    key={item.id}
                    ctx={ctx}
                    item={item}
                    dragging={draggingId === item.id}
                    onPointerDown={(e) => onAppPointerDown(e, item.id, f.name)}
                    onLaunch={() => tryLaunch(item.path, item.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 右键菜单渲染在面板根内部（但它是 fixed，不受 pane 的 overflow 约束，见
          FenceContextMenu 的文件头）。`key` 让「在另一个条目上再点右键」= 重挂载，
          于是上一轮展开的子菜单不会带过来。 */}
      {menu ? (
        <FenceContextMenu
          key={menu.target.kind === "blank" ? "blank" : menu.target.item.id}
          target={menu.target}
          io={menuIo}
          at={menu.at}
          zoomEl={rootRef.current}
          onClose={closeMenu}
        />
      ) : null}

      {/* 弹窗。挂在面板根里 = 落在 `.pane-fences` 子树内 —— 样式审查扫的就是那棵
          子树，挂到根外面它会永远待在护栏之外（`FenceDialog.tsx` 的注释）。
          它在菜单**之后**渲染只是顺序上的巧合：两者能不能同时出现由层叠决定
          （遮罩 z-index 60 > 菜单 40），不靠 DOM 先后。 */}
      {dialogNode}
    </div>
  );
}

export default FencePanel;
