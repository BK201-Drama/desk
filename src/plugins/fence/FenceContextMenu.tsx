/**
 * 看板的右键菜单。**只负责渲染与摆位**：出哪些项由 `contextMenuModel` 决定，
 * 每项跑什么命令由传进来的 `io` 决定 —— 这个文件不知道有哪些菜单项。
 *
 * 四条实测约束（别凭直觉改）：① 菜单是 fixed 却渲染在带 `overflow: hidden` 的 `.pane-fences`
 * 里而**裁不到**（`.board` 的 `backdrop-filter` 让它成了 fixed 后代的包含块）；② `clientX/Y` 与
 * `getBoundingClientRect()` 同坐标系，所以 `left = 屏幕 x / Z`；③ Z 是两层 `zoom: 1.28` 叠出的
 * 1.6384，**不许写死**，量出来（`measureZoom`）；④ 子菜单也必须是 fixed（否则包含块回到 pane
 * 内部、向左展开会被左边缘切掉）—— `.fence-menu-li` 的 `position: static` 即为此。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import type { CommandName } from "../../generated/commands";
import type { FenceDialogApi } from "./FenceDialog";
import {
  baseName,
  clampToViewport,
  contextMenuModel,
  isSeparator,
  withPreservedExtension,
  type MenuIo,
  type MenuItem,
  type MenuTarget,
} from "./contextMenuModel";

/** 屏幕像素 ÷ CSS 像素。量出来，不问它是几层 zoom 叠的。 */
function measureZoom(el: HTMLElement | null): number {
  if (el) {
    const w = el.offsetWidth;
    if (w > 0) {
      const z = el.getBoundingClientRect().width / w;
      if (z > 0.25 && z < 4) return z;
    }
  }
  const num = (v: string) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  const z =
    num(getComputedStyle(document.body).zoom) *
    num(getComputedStyle(document.documentElement).zoom);
  return z > 0.25 && z < 4 ? z : 1;
}

const toCss = (p: { x: number; y: number }, zoom: number) => ({
  left: `${p.x / zoom}px`,
  top: `${p.y / zoom}px`,
});

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

type Props = {
  target: MenuTarget;
  io: MenuIo;
  /** 打开菜单那一刻的指针位置（屏幕像素，与 `clientX` 同源）。 */
  at: { x: number; y: number };
  onClose: () => void;
  /** 用来量 Z 的元素（面板根，一定在、`offsetWidth` 一定非 0）。 */
  zoomEl: HTMLElement | null;
};

export function FenceContextMenu({ target, io, at, onClose, zoomEl }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: string; top: string } | null>(null);
  const [sub, setSub] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const zoomRef = useRef(1);

  const items = useMemo(() => contextMenuModel(target, io), [target, io]);

  // 先 hidden 渲染 → 量尺寸 → 夹进视口 → 摆位。useLayoutEffect 在 paint 前跑完，**不会闪**。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const zoom = measureZoom(zoomEl);
    zoomRef.current = zoom;
    const r = el.getBoundingClientRect();
    setPos(toCss(clampToViewport(at, { w: r.width, h: r.height }, viewport()), zoom));
  }, [at, zoomEl]);

  // 点外面关。放**捕获**阶段：菜单外的先关掉、事件再照常落到它本来该去的地方。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // Esc 关。**必须捕获 + stopPropagation**：`FencePanel` 冒泡阶段也在处理 Escape（清空搜索）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 滚动 / 改窗口大小都要关（菜单是 fixed，留着就是错位）。`scroll` 不冒泡，
  // 靠**捕获**阶段才收得到任何滚动容器的事件。
  useEffect(() => {
    const away = () => onClose();
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [onClose]);

  const pick = useCallback(
    (item: MenuItem) => {
      if (item.submenu || !item.enabled) return;
      onClose();
      item.run();
    },
    [onClose]
  );

  return (
    <div
      ref={menuRef}
      className="fence-menu"
      role="menu"
      data-testid="fence-menu"
      style={{
        ...(pos ?? { left: "0px", top: "0px" }),
        visibility: pos ? undefined : "hidden",
      }}
    >
      <ul>
        {items.map((item, idx) =>
          isSeparator(item) ? (
            // 分隔线没有 id 可言（SEP 是同一个对象被复用多次），只能用下标当 key。
            <li key={`sep-${idx}`} className="fence-menu-sep" role="separator" />
          ) : (
            <li
              key={item.id}
              className="fence-menu-li"
              // 子菜单是这里的 **DOM 子节点** → `pointerleave` 按 DOM 包含判定，不需要
              // setTimeout 防抖或给两者之间留一条「走过去的桥」。
              onPointerEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSub(item.submenu ? { id: item.id, anchor: r } : null);
              }}
              onPointerLeave={() => setSub((s) => (s?.id === item.id ? null : s))}
            >
              <button
                type="button"
                role="menuitem"
                className="fence-menu-item"
                data-menu-id={item.id}
                disabled={!item.enabled}
                aria-haspopup={item.submenu ? "menu" : undefined}
                aria-expanded={item.submenu ? sub?.id === item.id : undefined}
                onClick={(e) => {
                  if (item.submenu) {
                    setSub({ id: item.id, anchor: e.currentTarget.getBoundingClientRect() });
                    return;
                  }
                  pick(item);
                }}
              >
                <span className="fence-menu-label">{item.label}</span>
                {item.submenu ? (
                  <span className="fence-menu-arrow" aria-hidden="true">
                    ›
                  </span>
                ) : null}
              </button>
              {item.submenu && sub?.id === item.id ? (
                <SubMenu
                  items={item.submenu}
                  anchor={sub.anchor}
                  zoom={zoomRef.current}
                  onPick={pick}
                />
              ) : null}
            </li>
          )
        )}
      </ul>
    </div>
  );
}

function SubMenu({
  items,
  anchor,
  zoom,
  onPick,
}: {
  items: MenuItem[];
  anchor: DOMRect;
  zoom: number;
  onPick: (item: MenuItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: string; top: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const GAP = 2;
    // 优先向右展开；右边放不下就翻到左边。pane 挂在右半边，实际几乎总是向左。
    let x = anchor.right + GAP;
    if (x + r.width > window.innerWidth) x = anchor.left - r.width - GAP;
    setPos(toCss(clampToViewport({ x, y: anchor.top }, { w: r.width, h: r.height }, viewport()), zoom));
  }, [anchor, zoom, items]);

  return (
    <div
      ref={ref}
      className="fence-menu-sub"
      role="menu"
      data-testid="fence-menu-sub"
      style={{
        ...(pos ?? { left: "0px", top: "0px" }),
        visibility: pos ? undefined : "hidden",
      }}
    >
      <ul>
        {items.map((item) => (
          <li key={item.id} className="fence-menu-li">
            <button
              type="button"
              role="menuitem"
              className="fence-menu-item"
              data-menu-id={item.id}
              disabled={!item.enabled}
              onClick={() => onPick(item)}
            >
              <span className="fence-menu-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 菜单的**命令通道**：菜单项说什么，这里就调什么。
 *
 * ⚠️ Tauri 2 的命令参数默认是 **camelCase**：`fence_rename(path, new_name)` 必须发
 * `{ path, newName }`，写成 `new_name` 会 `invalid args` 失败，而**这个错 e2e 看不出来**
 * （mock 只按命令名分发）—— `e2e/fence-menu.spec.ts` 因此断言了参数名本身。
 *
 * 每个调用都 `.catch(alert)`：菜单不显眼，静默失败最坏（用户以为点过了）。
 */
export function useMenuIo(
  ctx: HostContext,
  open: (path: string, id: string) => void,
  dlg: FenceDialogApi,
  /**
   * 显示偏好那两个动作（收起 / 高度）。**必须由调用方注入**：那条命令的返回值是
   * **一帧新的看板**，丢掉它前端就会一直画旧的（它改 `fence.json`，不触发 watcher 推送）。
   */
  ui: {
    setCollapsed: (name: string, collapsed: boolean) => void;
    setRows: (name: string, rows: number) => void;
  }
): MenuIo {
  const call = useCallback(
    (cmd: CommandName, args?: Record<string, unknown>) => {
      // 失败一律说出来：后端那句中文（含路径）比「操作失败」四个字有用得多。
      void ctx
        .invoke(cmd, args)
        .catch((e) => void dlg.alert({ title: "操作失败", detail: String(e) }));
    },
    [ctx, dlg]
  );

  return useMemo<MenuIo>(
    () => ({
      // 「打开」必须走面板那个唯一的启动入口（`FencePanel` 的 doLaunch），否则会出现
      // 「从菜单打开的东西不进最近」这条路上独有的怪 bug。
      open: (path, id) => open(path, id),
      openWith: (path) => call("fence_open_with", { path }),
      reveal: (path) => call("fence_reveal", { path }),
      newItem: (kind) =>
        call("fence_create", {
          name: kind === "folder" ? "新建文件夹" : "新建文本文档",
          kind,
          // `Option<String>` 显式发 null：不缺字段，免得依赖后端对缺键的宽容度。
          target: null,
        }),
      clipboard: (path, cut) => call("fence_clipboard", { paths: [path], cut }),
      paste: () => call("fence_paste"),
      rename: (path) => {
        // 旧名从 **path 的 basename** 取，不能从 label 取：label 已被后端去掉了扩展名。
        const old = baseName(path);
        void (async () => {
          // `prompt` 的 `null` = 用户取消（不发命令）；空串走下面的 `if (!name)`。
          const input = await dlg.prompt({ title: "重命名为", initial: old });
          if (input == null) return;
          const name = withPreservedExtension(old, input);
          if (!name) return; // 只打了空格
          call("fence_rename", { path, newName: name });
        })();
      },
      // **不弹确认框**：删除本来就进回收站（`fence_delete` 带 `FOF_ALLOWUNDO`），别再加回来。
      remove: (path) => call("fence_delete", { path }),
      sendTo: (path) => call("fence_send_to", { path }),
      compress: (path) => call("fence_compress", { path }),
      properties: (path) => call("fence_properties", { path }),
      setCollapsed: (name, collapsed) => ui.setCollapsed(name, collapsed),
      setRows: (name, rows) => ui.setRows(name, rows),
    }),
    [call, open, ui]
  );
}
