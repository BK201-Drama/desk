import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { HostContext } from "../../host/types";
import { DRAG_THRESHOLD_PX, moveItemAcross, type FenceGroup } from "../../domain/fence";

/** application/UI：编辑模式下拖拽重排 */
export function useFenceDnD(
  ctx: HostContext,
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
    if (!ctx.editing() || e.button !== 0) return;
    if (itemId.startsWith("sys-") || fenceName === "系统") return;
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
