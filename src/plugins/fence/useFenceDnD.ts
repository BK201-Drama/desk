import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DRAG_THRESHOLD_PX, moveItemAcross, type FenceGroup } from "./model";

/**
 * 拖拽重排（跨围栏搬图标）。
 *
 * ── 2026-09-13 拆掉了编辑态那道闸（用户需求：「支持用户自己拖拽图标到分类里」）──
 *
 * 原先第一句是 `if (!ctx.editing() || e.button !== 0) return`，也就是拖拽只在
 * `Win+Shift+D` 的重排模式下可用。那道闸的存在理由写在 spec §7.3：
 * 「点」与「拖」分进两个模式，就不必判断这一下到底是点还是拖。
 *
 * **但那个判断这个文件早就自己做掉了**，闸门是多余的：
 *   · `DRAG_THRESHOLD_PX` 之内不算拖（`p.active` 一直是 false）；
 *   · 真拖了才立 `suppressClick`，紧接着那一下 `click` 会被 `tryLaunch` 吃掉。
 * 于是拆闸之后语义不变，只是不再需要先想起一个热键 —— 用户根本不知道有那个键。
 *
 * 编辑态**没有被删掉**，它还剩「点击不启动」（`doLaunch` 里那道 `ctx.editing()`）。
 *
 * 拆闸之后这个 hook 不再需要 `ctx`（原先只用来问 `ctx.editing()`），
 * 所以第一个参数**去掉了** —— 与 `moveItemAcross` 一样，它现在是个纯 UI 组件。
 */
export function useFenceDnD(
  fences: FenceGroup[],
  onPersist: (next: FenceGroup[]) => void
) {
  const fencesRef = useRef(fences);
  fencesRef.current = fences;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const pointer = useRef<{
    id: number;
    itemId: string;
    startX: number;
    startY: number;
    active: boolean;
    targetFence?: string;
    beforeId?: string | null;
  } | null>(null);
  const suppressClick = useRef(false);

  const onAppPointerDown = (e: ReactPointerEvent, itemId: string, fenceName: string) => {
    // 只认左键。中键/右键不拖 —— 右键要留给菜单。
    if (e.button !== 0) return;
    if (itemId.startsWith("sys-") || fenceName === "系统") return;
    // `suppressClick` 的作用域是**一次手势**，不是「直到下一次点图标」。
    // 拆闸之前它够用：那时点击本来就不启动（编辑态），漏消费也看不出来。
    // 现在不一样了 —— 「拖到空白处松手」那一下 click 落在 `.fence` 上，
    // 没有任何 `.fence-app` 的 onClick 去消费它，于是标记一直挂着，
    // 下一次**正常点图标**会被它静默吃掉（症状：第一次点没反应）。
    // 这里清零是安全的：属于本次拖拽的那一下 click 一定排在下一次 pointerdown 之前。
    suppressClick.current = false;
    pointer.current = {
      id: e.pointerId,
      itemId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };

    const onMove = (ev: PointerEvent) => {
      const p = pointer.current;
      if (!p || ev.pointerId !== p.id) return;
      const dx = ev.clientX - p.startX;
      const dy = ev.clientY - p.startY;
      if (!p.active) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        p.active = true;
        setDraggingId(p.itemId);
      }
      ev.preventDefault();
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      document.querySelectorAll(".fence-grid.drag-over").forEach((n) => n.classList.remove("drag-over"));
      const grid = el?.closest<HTMLElement>(".fence-grid");
      const fence = grid?.closest<HTMLElement>(".fence");
      if (grid && fence && fence.dataset.name !== "系统") {
        grid.classList.add("drag-over");
        p.targetFence = fence.dataset.name;
        const apps = [...grid.querySelectorAll<HTMLElement>(".fence-app")].filter(
          (a) => a.dataset.id !== p.itemId
        );
        let beforeId: string | null = null;
        for (const app of apps) {
          const r = app.getBoundingClientRect();
          const before =
            ev.clientY < r.top + r.height / 2 ||
            (ev.clientY <= r.bottom && ev.clientX < r.left + r.width / 2);
          if (before) {
            beforeId = app.dataset.id ?? null;
            break;
          }
        }
        p.beforeId = beforeId;
      }
    };

    const onUp = (ev: PointerEvent) => {
      const p = pointer.current;
      if (!p || ev.pointerId !== p.id) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.querySelectorAll(".fence-grid.drag-over").forEach((n) => n.classList.remove("drag-over"));
      if (p.active && p.targetFence) {
        suppressClick.current = true;
        const next = moveItemAcross(
          fencesRef.current,
          p.itemId,
          p.targetFence,
          p.beforeId ?? null
        );
        onPersist(next);
      }
      pointer.current = null;
      setDraggingId(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const consumeSuppressClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return true;
    }
    return false;
  };

  return { draggingId, onAppPointerDown, consumeSuppressClick };
}
