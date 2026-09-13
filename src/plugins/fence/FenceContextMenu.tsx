/**
 * 看板的右键菜单。**只负责渲染与摆位**：出哪些项由 `contextMenuModel` 决定，
 * 每项跑什么命令由传进来的 `io` 决定 —— 这个文件不知道有哪些菜单项。
 *
 * ── 定位这件事的结论（都是实测，别凭直觉改）───────────────────────────────
 *
 * 1. 菜单是 `position: fixed`，渲染在 `.pane-fences` 里面。`.pane-fences` 有
 *    `overflow: hidden`（styles.css:184），但**裁不到**它：`.board` 的
 *    `backdrop-filter`（styles.css:66-68）使 `.board` 成为 fixed 后代的包含块，
 *    菜单因此脱离了 pane 的裁剪链，可以摆到视口任何地方。
 * 2. `MouseEvent.clientX/Y` 与 `getBoundingClientRect()` 是**同一个坐标系**
 *    （都是「缩放之后的屏幕像素」）。所以 `left = 屏幕 x / Z` 就能把元素放到那个点。
 * 3. Z（屏幕像素 ÷ CSS 像素）是**两层 `zoom: 1.28` 叠出来的** 1.6384
 *    （styles.css:30-39 的 `html, body` 双选择器）。**不写死** —— 量出来，
 *    见 `measureZoom`。写死的话，改一次 `--desk-zoom` 菜单位置就悄悄偏掉。
 * 4. 子菜单**也必须是 fixed**：纯 CSS 的 `position: absolute` 方案要求父 `<li>`
 *    是 `position: relative`，那个包含块在 pane **内部** → 向左展开的子菜单会被
 *    pane 的左边缘切掉。fixed 才落回 `.board`（第 1 条）。这就是 `.fence-menu-li`
 *    在 panel.css 里被显式写成 `position: static` 的原因。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
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
  // 量不到（元素还没布局 / 被 transform）就退回 computed style 相乘。
  const num = (v: string) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  const z =
    num(getComputedStyle(document.body).zoom) *
    num(getComputedStyle(document.documentElement).zoom);
  return z > 0.25 && z < 4 ? z : 1;
}

/** 屏幕坐标 → fixed 元素能直接用的 `left` / `top`（CSS px）。 */
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
  /** 展开中的子菜单：父条目的 id + 它的矩形（子菜单靠矩形定位）。 */
  const [sub, setSub] = useState<{ id: string; anchor: DOMRect } | null>(null);
  /** 量到的 Z。子菜单复用同一个值，不重量一遍（量的是同一个文档）。 */
  const zoomRef = useRef(1);

  const items = useMemo(() => contextMenuModel(target, io), [target, io]);

  // 先按 `visibility: hidden` 渲染 → 量到自己的尺寸 → 夹进视口 → 摆位。
  // useLayoutEffect 在 paint 之前跑完，所以**不会闪一下未定位的菜单**。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const zoom = measureZoom(zoomEl);
    zoomRef.current = zoom;
    const r = el.getBoundingClientRect();
    setPos(toCss(clampToViewport(at, { w: r.width, h: r.height }, viewport()), zoom));
  }, [at, zoomEl]);

  // 点外面关。放**捕获**阶段：菜单内的 `pointerdown` 用 contains 放过，
  // 菜单外的先关掉、事件再照常落到它本来该去的地方。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // Esc 关。**必须捕获 + stopPropagation**：`FencePanel.tsx:150` 那个冒泡阶段的
  // document keydown 也在处理 Escape（清空搜索）。不抢的话一次 Esc 会同时
  // 关菜单和清搜索 —— 两件事一起发生，用户会觉得「按一下少了两样东西」。
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

  // 滚动 / 改窗口大小都要关：菜单是 fixed，不跟着内容走，留着就是错位。
  // `scroll` 不冒泡，但捕获阶段能在 window 上收到**任何**滚动容器的事件。
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
              // 子菜单是这里的 **DOM 子节点** → `pointerleave` 按 DOM 包含判定，
              // 不看几何位置，「从条目移进子菜单」不会触发它。于是不需要任何
              // setTimeout 防抖，也不需要给两者之间留一条「走过去的桥」。
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
                  // 有子菜单的项不接受点击动作：点它只展开（鼠标用户其实靠悬停）。
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
 * ⚠️ Tauri 2 的命令参数默认是 **camelCase**（`tauri-macros` 的
 * `argument_case: ArgumentCase::Camel` → `to_lower_camel_case()`）。
 * `fence_rename(path, new_name)` 必须发 `{ path, newName }` —— 写成 `new_name`
 * 会以 `invalid args` 失败，而**这个错在 e2e 里看不出来**（mock 只按命令名分发），
 * 所以 `e2e/fence-menu.spec.ts` 特意断言了参数名本身。
 *
 * 每个调用都 `.catch(alert)`：右键菜单是个不显眼的地方，静默失败最坏 ——
 * 用户以为点过了、其实什么都没发生。与同文件里 autostart / restore 的处理一致。
 *
 * `withKeyboard` 是**弹原生对话框的必要条件**，不是锦上添花：窗口是
 * `WS_EX_NOACTIVATE` 的，不先借键盘，`prompt()` 的框会画出来但打不进字。
 * 完整因果写在 `FencePanel.tsx` 的 `withKeyboard` 上。
 */
export function useMenuIo(
  ctx: HostContext,
  open: (path: string, id: string) => void,
  withKeyboard: <T>(fn: () => T) => Promise<T>
): MenuIo {
  const call = useCallback(
    (cmd: string, args?: Record<string, unknown>) => {
      // 报错也要弹 alert —— 同一条约束：alert 也需要键盘（Esc / 回车关掉它）。
      void ctx.invoke(cmd, args).catch((e) => void withKeyboard(() => alert(String(e))));
    },
    [ctx, withKeyboard]
  );

  return useMemo<MenuIo>(
    () => ({
      // 「打开」必须走面板那个唯一的启动入口（`FencePanel.tsx:91` 的 doLaunch），
      // 否则会出现「从右键菜单打开的东西不进最近」这种只在这一条路上复现的怪 bug。
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
        // 旧名从 **path 的 basename** 取，不能从 label 取：看板上文件的 label
        // 已经被后端去掉了扩展名（`index.rs:74` → `Cursor.lnk` 显示成 `Cursor`）。
        const old = baseName(path);
        void withKeyboard(() => {
          const input = prompt("重命名为", old);
          if (input == null) return; // 用户取消
          const name = withPreservedExtension(old, input);
          if (!name) return; // 只打了空格
          call("fence_rename", { path, newName: name });
        });
      },
      // 多一层确认是**故意**偏离资源管理器的（它不弹）：desk 的删除对象是用户的真文件，
      // 而这里没有 Ctrl+Z。进回收站虽然可还原，但用户得先知道它去哪了。
      // 同文件 `fence_restore` 已有同样的先例（`FencePanel.tsx:117`）。
      remove: (path) => {
        void withKeyboard(() => {
          if (!confirm(`删除「${baseName(path)}」？\n会进回收站，可以还原。`)) return;
          call("fence_delete", { path });
        });
      },
      sendTo: (path) => call("fence_send_to", { path }),
      compress: (path) => call("fence_compress", { path }),
      properties: (path) => call("fence_properties", { path }),
    }),
    [call, open]
  );
}
