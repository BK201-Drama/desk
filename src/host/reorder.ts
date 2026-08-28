import { isEditing, onEditChange } from "./edit";
import { applyDomOrders, setPluginOrder } from "./registry";

let dragId: string | null = null;
let bound = false;

function pluginRootFromEvent(e: Event): HTMLElement | null {
  const t = e.target as HTMLElement | null;
  if (!t) return null;
  // 仅左栏：右栏围栏用 pointer 拖图标，避免和 HTML5 拖拽冲突
  const root = t.closest("#slot-left > [data-plugin]");
  return root as HTMLElement | null;
}

function setDraggable(on: boolean) {
  document.querySelectorAll<HTMLElement>("#slot-left > [data-plugin]").forEach((el) => {
    el.draggable = on;
    el.classList.toggle("plugin-reorderable", on);
  });
  document.querySelectorAll<HTMLElement>("#slot-right > [data-plugin]").forEach((el) => {
    el.draggable = false;
    el.classList.remove("plugin-reorderable");
  });
}

function onDragStart(e: DragEvent) {
  if (!isEditing()) {
    e.preventDefault();
    return;
  }
  const root = pluginRootFromEvent(e);
  if (!root?.dataset.plugin) {
    e.preventDefault();
    return;
  }
  dragId = root.dataset.plugin;
  root.classList.add("is-dragging");
  e.dataTransfer?.setData("text/plugin-id", dragId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onDragEnd(e: DragEvent) {
  pluginRootFromEvent(e)?.classList.remove("is-dragging");
  document
    .querySelectorAll(".plugin-drop-before, .plugin-drop-after")
    .forEach((el) => el.classList.remove("plugin-drop-before", "plugin-drop-after"));
  dragId = null;
}

function onDragOver(e: DragEvent) {
  if (!isEditing() || !dragId) return;
  const over = pluginRootFromEvent(e);
  if (!over?.dataset.plugin || over.dataset.plugin === dragId) return;
  if (over.parentElement !== document.querySelector(`[data-plugin="${dragId}"]`)?.parentElement) {
    return;
  }
  e.preventDefault();
  const rect = over.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  over.classList.toggle("plugin-drop-before", before);
  over.classList.toggle("plugin-drop-after", !before);
  document.querySelectorAll("[data-plugin]").forEach((el) => {
    if (el !== over) el.classList.remove("plugin-drop-before", "plugin-drop-after");
  });
}

async function onDrop(e: DragEvent) {
  if (!isEditing() || !dragId) return;
  const over = pluginRootFromEvent(e);
  if (!over?.dataset.plugin || over.dataset.plugin === dragId) return;
  e.preventDefault();
  const parent = over.parentElement;
  if (!parent) return;
  const ids = [...parent.querySelectorAll<HTMLElement>(":scope > [data-plugin]")].map(
    (el) => el.dataset.plugin!
  );
  const from = ids.indexOf(dragId);
  let to = ids.indexOf(over.dataset.plugin);
  if (from < 0 || to < 0) return;
  const rect = over.getBoundingClientRect();
  const after = e.clientY >= rect.top + rect.height / 2;
  const next = ids.filter((id) => id !== dragId);
  to = next.indexOf(over.dataset.plugin);
  if (after) to += 1;
  next.splice(to, 0, dragId);
  // 合并左右槽顺序写入全局 order
  const left = [...(document.getElementById("slot-left")?.children ?? [])]
    .map((el) => (el as HTMLElement).dataset.plugin)
    .filter((id): id is string => !!id);
  const right = [...(document.getElementById("slot-right")?.children ?? [])]
    .map((el) => (el as HTMLElement).dataset.plugin)
    .filter((id): id is string => !!id);
  const slot = parent.id === "slot-right" ? "right" : "left";
  const merged = slot === "left" ? [...next, ...right] : [...left, ...next];
  applyDomOrders(next.map((id, i) => ({ id, order: i * 10 })));
  try {
    await setPluginOrder(merged);
  } catch (err) {
    console.error(err);
  }
  onDragEnd(e);
}

/** 编辑态：左右槽插件可拖拽改序 */
export function initReorderDrag(): void {
  if (bound) return;
  bound = true;
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("dragend", onDragEnd, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  onEditChange((on) => setDraggable(on));
  setDraggable(isEditing());
}
