import { getCurrentWindow } from "@tauri-apps/api/window";
import type { HostContext, PluginModule } from "../../host/types";
import { escapeHtml, isTextField } from "../../host/util";
import { setEditing, toggleEditing } from "../../host/edit";

const RECENT_MAX = 4;
const RECENT_LS_KEY = "desk-recent-v1";
const DRAG_THRESHOLD_PX = 6;

const SEARCH_ALIASES: Record<string, string[]> = {
  英雄联盟: ["lol", "yxlm", "联盟", "league"],
  "counter-strike 2": ["cs", "cs2", "反恐"],
  穿越火线: ["cf"],
  饥荒联机版: ["饥荒", "dst"],
  terraria: ["泰拉"],
  飞书: ["feishu", "lark"],
  文献批量阅读助手: ["文献", "paper"],
  此电脑: ["pc", "mycomputer", "计算机"],
  回收站: ["recycle", "trash", "垃圾箱"],
};

type FenceItemDto = {
  id: string;
  label: string;
  path: string;
  icon: string | null;
};
type FenceDto = { name: string; items: FenceItemDto[] };
type FenceLayout = { name: string; ids: string[] };

let ctxRef: HostContext | null = null;
let rootEl: HTMLElement | null = null;
let unsubEdit: (() => void) | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

let fencePointer: {
  id: number;
  el: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
} | null = null;
let fenceSuppressClick = false;
let fenceFilter = "";
let allFences: FenceDto[] = [];
let searchSelectedIndex = -1;
let recentIds: string[] = [];

function editing() {
  return ctxRef?.editing() ?? false;
}

async function setTextInputActive(active: boolean) {
  if (!ctxRef) return;
  try {
    await ctxRef.invoke("set_keyboard_input", { active });
    if (active) await getCurrentWindow().setFocus();
  } catch (e) {
    console.warn("set_keyboard_input", e);
  }
}

function iconUrl(icon: string | null, label: string): string {
  if (icon && ctxRef) {
    try {
      return `background-image:url('${ctxRef.convertFileSrc(icon)}')`;
    } catch {
      return `background-image:url('${icon}')`;
    }
  }
  if (label === "回收站") return "background:linear-gradient(145deg,#94a3b8,#475569)";
  if (label === "此电脑") return "background:linear-gradient(145deg,#93c5fd,#2563eb)";
  return "background:linear-gradient(145deg,#c4b5fd,#7c3aed)";
}

function findItemById(id: string): FenceItemDto | null {
  for (const f of allFences) {
    const item = f.items.find((i) => i.id === id);
    if (item) return item;
  }
  return null;
}

async function migrateRecentFromLocalStorage() {
  if (!ctxRef) return;
  try {
    if (recentIds.length) return;
    const raw = localStorage.getItem(RECENT_LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    const legacy = parsed
      .filter((x): x is string => typeof x === "string" && !x.startsWith("sys-"))
      .slice(0, RECENT_MAX);
    localStorage.removeItem(RECENT_LS_KEY);
    if (!legacy.length) return;
    for (const id of [...legacy].reverse()) {
      recentIds = await ctxRef.invoke<string[]>("recent_push", { id });
    }
  } catch {
    /* ignore */
  }
}

async function loadRecentFromDisk() {
  if (!ctxRef) return;
  try {
    recentIds = await ctxRef.invoke<string[]>("recent_list");
    recentIds = recentIds.slice(0, RECENT_MAX);
    await migrateRecentFromLocalStorage();
  } catch (e) {
    console.warn("recent_list", e);
    recentIds = [];
  }
}

function recordRecentLaunch(item: FenceItemDto) {
  if (!ctxRef || item.id.startsWith("sys-")) return;
  void ctxRef
    .invoke<string[]>("recent_push", { id: item.id })
    .then((ids) => {
      recentIds = ids.slice(0, RECENT_MAX);
      renderRecentBar();
    })
    .catch((e) => console.warn("recent_push", e));
}

function matchesFenceSearch(item: FenceItemDto, q: string): boolean {
  const label = item.label.toLowerCase();
  if (label.includes(q)) return true;
  const base = item.path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base.includes(q)) return true;
  const aliases = SEARCH_ALIASES[item.label] ?? SEARCH_ALIASES[label] ?? [];
  if (aliases.some((a) => a.includes(q) || q.includes(a))) return true;
  for (const tokens of Object.values(SEARCH_ALIASES)) {
    if (tokens.includes(q) && tokens.some((t) => label.includes(t))) return true;
  }
  return false;
}

function focusFenceSearch() {
  const el = rootEl?.querySelector("#fenceSearch") as HTMLInputElement | null;
  if (!el) return;
  void setTextInputActive(true);
  el.focus();
  el.select();
}

function clearFenceSearch() {
  fenceFilter = "";
  searchSelectedIndex = -1;
  const el = rootEl?.querySelector("#fenceSearch") as HTMLInputElement | null;
  if (el) el.value = "";
  applyFenceFilter();
}

function updateSearchSelection(rows: HTMLElement[]) {
  rows.forEach((row, idx) => {
    row.classList.toggle("is-selected", idx === searchSelectedIndex);
  });
  rows[searchSelectedIndex]?.scrollIntoView({ block: "nearest" });
}

function getQuickBarItems(): FenceItemDto[] {
  return recentIds
    .slice(0, RECENT_MAX)
    .map((id) => findItemById(id))
    .filter((item): item is FenceItemDto => item !== null && !item.id.startsWith("sys-"));
}

function hideRecentBar() {
  const root = rootEl?.querySelector("#fenceRecent") as HTMLElement | null;
  if (!root) return;
  root.hidden = true;
  root.className = "";
  root.innerHTML = "";
}

function renderRecentBar() {
  const root = rootEl?.querySelector("#fenceRecent") as HTMLElement | null;
  if (!root) return;
  if (fenceFilter.trim()) {
    hideRecentBar();
    return;
  }
  const items = getQuickBarItems();
  if (!items.length) {
    hideRecentBar();
    return;
  }
  root.hidden = false;
  root.className = "fence";
  root.innerHTML = `
    <div class="fence-title">最近 <em>${items.length}</em></div>
    <div class="fence-grid">${items.map((item) => fenceAppButton(item, escapeHtml(item.label))).join("")}</div>`;
  wireFenceLaunch(root);
}

function launchFenceItem(path: string, id?: string) {
  if (editing() || !ctxRef) return;
  if (id) {
    const item = findItemById(id);
    if (item) recordRecentLaunch(item);
  }
  void ctxRef
    .invoke("fence_launch", { path })
    .then(() => ctxRef?.emit("fence:launch", { path, id }))
    .catch((err) => console.error(err));
}

function getSearchRows(): HTMLElement[] {
  const list = rootEl?.querySelector("#fenceSearchResults .fence-search-list");
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>(".fence-search-row")];
}

function launchSelectedSearchRow() {
  const rows = getSearchRows();
  if (searchSelectedIndex < 0 || searchSelectedIndex >= rows.length) return;
  const row = rows[searchSelectedIndex];
  const path = row.dataset.path;
  if (!path) return;
  launchFenceItem(path, row.dataset.id);
}

function highlightLabel(label: string, q: string) {
  if (!q) return escapeHtml(label);
  const lower = label.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return escapeHtml(label);
  const before = escapeHtml(label.slice(0, idx));
  const mid = escapeHtml(label.slice(idx, idx + q.length));
  const after = escapeHtml(label.slice(idx + q.length));
  return `${before}<mark>${mid}</mark>${after}`;
}

function fenceAppButton(item: FenceItemDto, labelHtml: string, extra = "") {
  const bg = iconUrl(item.icon, item.label);
  const pathAttr = item.path.replace(/"/g, "&quot;");
  const idAttr = item.id.replace(/"/g, "&quot;");
  return `<button type="button" class="fence-app${extra}" data-id="${idAttr}" data-path="${pathAttr}" title="${escapeHtml(item.label)}">
    <div class="face" style="${bg}"></div>
    <span class="label">${labelHtml}</span>
  </button>`;
}

function wireFenceLaunch(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>(".fence-app, .fence-search-row").forEach((btn) => {
    btn.onclick = (e) => {
      if (fenceSuppressClick) {
        fenceSuppressClick = false;
        e.preventDefault();
        return;
      }
      const path = btn.dataset.path;
      if (!path) return;
      launchFenceItem(path, btn.dataset.id);
    };
  });
}

function applyFenceFilter() {
  if (!rootEl) return;
  const root = rootEl.querySelector("#fences") as HTMLElement | null;
  const hitsEl = rootEl.querySelector("#fenceSearchResults") as HTMLElement | null;
  if (!root || !hitsEl) return;

  const q = fenceFilter.trim().toLowerCase();
  rootEl.classList.toggle("is-searching", Boolean(q));

  if (!q) {
    hitsEl.hidden = true;
    hitsEl.innerHTML = "";
    root.hidden = false;
    root.querySelectorAll<HTMLElement>(".fence").forEach((fence) => {
      fence.hidden = false;
      fence.querySelectorAll<HTMLElement>(".fence-app").forEach((app) => {
        app.hidden = false;
      });
      const n = fence.querySelectorAll(".fence-app").length;
      const em = fence.querySelector(".fence-title em");
      if (em) em.textContent = String(n);
    });
    const total = allFences.reduce((n, f) => n + f.items.length, 0);
    const countEl = rootEl.querySelector("#fenceCount");
    if (countEl) countEl.textContent = `· ${total}`;
    renderRecentBar();
    return;
  }

  type Hit = { item: FenceItemDto; fence: string };
  const hits: Hit[] = [];
  for (const f of allFences) {
    for (const item of f.items) {
      if (matchesFenceSearch(item, q)) hits.push({ item, fence: f.name });
    }
  }

  const recentRoot = rootEl.querySelector("#fenceRecent") as HTMLElement | null;
  if (recentRoot) recentRoot.hidden = true;

  root.hidden = true;
  hitsEl.hidden = false;

  const countEl = rootEl.querySelector("#fenceCount");
  if (countEl) countEl.textContent = `· ${hits.length} 匹配`;

  if (!hits.length) {
    const query = escapeHtml(fenceFilter.trim());
    hitsEl.innerHTML = `
      <div class="fence-search-panel">
        <div class="fence-search-empty-wrap">
          <p class="fence-search-empty">无「${query}」</p>
          <p class="fence-search-hint">试试英文名、拼音缩写或路径片段</p>
          <button type="button" class="fence-search-clear" id="fenceSearchClear">清除搜索</button>
        </div>
      </div>`;
    hitsEl.querySelector("#fenceSearchClear")?.addEventListener("click", () => {
      clearFenceSearch();
      focusFenceSearch();
    });
    searchSelectedIndex = -1;
    return;
  }

  searchSelectedIndex = 0;
  const query = escapeHtml(fenceFilter.trim());
  hitsEl.innerHTML = `
    <div class="fence-search-panel">
      <div class="fence-search-meta"><span>${hits.length} 个结果</span><span class="fence-search-query">${query}</span></div>
      <div class="fence-search-list">
        ${hits
          .map((h, idx) => {
            const bg = iconUrl(h.item.icon, h.item.label);
            const pathAttr = h.item.path.replace(/"/g, "&quot;");
            const idAttr = h.item.id.replace(/"/g, "&quot;");
            const sel = idx === 0 ? " is-selected" : "";
            return `<button type="button" class="fence-search-row${sel}" data-id="${idAttr}" data-path="${pathAttr}" title="${escapeHtml(h.item.label)}">
              <div class="face" style="${bg}"></div>
              <div class="fence-search-row-text">
                <span class="label">${highlightLabel(h.item.label, q)}</span>
                <span class="cat">${escapeHtml(h.fence)}</span>
              </div>
            </button>`;
          })
          .join("")}
      </div>
    </div>`;
  wireFenceLaunch(hitsEl);
}

function collectFenceLayout(): FenceLayout[] {
  const root = rootEl?.querySelector("#fences");
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(".fence")]
    .map((fence) => {
      const name = fence.dataset.name ?? "";
      const ids = [...fence.querySelectorAll<HTMLElement>(".fence-app")]
        .map((el) => el.dataset.id ?? "")
        .filter((id) => id && !id.startsWith("sys-"));
      return { name, ids };
    })
    .filter((f) => f.name && f.name !== "系统");
}

function persistFenceOrder() {
  if (!ctxRef) return;
  const layout = collectFenceLayout();
  void ctxRef
    .invoke<FenceDto[]>("fence_save_order", { layout })
    .then((fences) => renderFences(fences))
    .catch((e) => console.error("fence_save_order", e));
}

function dragInsertTarget(
  grid: HTMLElement,
  x: number,
  y: number,
  dragging: HTMLElement
): HTMLElement | null {
  const apps = [...grid.querySelectorAll<HTMLElement>(".fence-app")].filter(
    (el) => el !== dragging
  );
  for (const app of apps) {
    const r = app.getBoundingClientRect();
    const before =
      y < r.top + r.height / 2 || (y <= r.bottom && x < r.left + r.width / 2);
    if (before) return app;
  }
  return null;
}

function placeDraggingAtPoint(dragging: HTMLElement, x: number, y: number) {
  dragging.style.pointerEvents = "none";
  const under = document.elementFromPoint(x, y);
  dragging.style.pointerEvents = "";
  const grid = under?.closest<HTMLElement>(".fence-grid");
  if (!grid) return;
  const fence = grid.closest<HTMLElement>(".fence");
  if (!fence || fence.dataset.name === "系统") return;

  document
    .querySelectorAll(".fence-grid.drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
  grid.classList.add("drag-over");

  const after = dragInsertTarget(grid, x, y, dragging);
  if (after == null) {
    if (dragging.parentElement !== grid || grid.lastElementChild !== dragging) {
      grid.appendChild(dragging);
    }
  } else if (after !== dragging.nextElementSibling) {
    grid.insertBefore(dragging, after);
  }
}

function endFencePointer(persist: boolean) {
  if (!fencePointer || !ctxRef) return;
  const { el, active, id } = fencePointer;
  el.classList.remove("dragging");
  try {
    el.releasePointerCapture(id);
  } catch {
    /* ignore */
  }
  window.removeEventListener("pointermove", onFenceWindowMove);
  window.removeEventListener("pointerup", onFenceWindowUp);
  window.removeEventListener("pointercancel", onFenceWindowCancel);
  document
    .querySelectorAll(".fence-grid.drag-over")
    .forEach((node) => node.classList.remove("drag-over"));
  fencePointer = null;
  if (active) {
    fenceSuppressClick = true;
    applyFenceFilter();
    if (persist) persistFenceOrder();
  }
}

function onFenceWindowMove(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  const dx = e.clientX - fencePointer.startX;
  const dy = e.clientY - fencePointer.startY;
  if (!fencePointer.active) {
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    fencePointer.active = true;
    fencePointer.el.classList.add("dragging");
  }
  e.preventDefault();
  placeDraggingAtPoint(fencePointer.el, e.clientX, e.clientY);
}

function onFenceWindowUp(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  endFencePointer(true);
}

function onFenceWindowCancel(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  endFencePointer(false);
}

function wireFenceDnD(root: HTMLElement) {
  root.onpointerdown = (e) => {
    if (!editing() || e.button !== 0) return;
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fence-app");
    if (!btn || !root.contains(btn)) return;
    if ((btn.dataset.id ?? "").startsWith("sys-")) return;
    if (btn.closest<HTMLElement>(".fence")?.dataset.name === "系统") return;

    fencePointer = {
      id: e.pointerId,
      el: btn,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    window.addEventListener("pointermove", onFenceWindowMove);
    window.addEventListener("pointerup", onFenceWindowUp);
    window.addEventListener("pointercancel", onFenceWindowCancel);
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  root.onpointermove = (e) => {
    if (!ctxRef) return;
    const over = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fence-app");
    const next = over
      ? editing()
        ? fencePointer?.active
          ? "grabbing"
          : "grab"
        : "pointer"
      : "default";
    void ctxRef.invoke("set_cursor", { icon: next }).catch(() => {});
  };
  root.onpointerleave = () => {
    void ctxRef?.invoke("set_cursor", { icon: "default" }).catch(() => {});
  };

  wireFenceLaunch(root);
}

function renderFences(fences: FenceDto[]) {
  allFences = fences;
  const root = rootEl?.querySelector("#fences") as HTMLElement | null;
  if (!root) return;
  let total = 0;
  root.innerHTML = fences
    .map((f) => {
      total += f.items.length;
      const apps = f.items
        .map((item) => fenceAppButton(item, escapeHtml(item.label)))
        .join("");
      return `<div class="fence" data-name="${f.name}">
      <div class="fence-title">${f.name} <em>${f.items.length}</em></div>
      <div class="fence-grid">${apps}</div>
    </div>`;
    })
    .join("");

  const countEl = rootEl?.querySelector("#fenceCount");
  if (countEl) countEl.textContent = `· ${total}`;

  wireFenceDnD(root);
  applyFenceFilter();
}

async function loadFences() {
  if (!ctxRef) return;
  await loadRecentFromDisk();
  try {
    const fences = await ctxRef.invoke<FenceDto[]>("fence_takeover");
    renderFences(fences);
    ctxRef.emit("fence:loaded", { count: fences.reduce((n, f) => n + f.items.length, 0) });
  } catch (e) {
    console.warn("fence_takeover failed, try list", e);
    try {
      const fences = await ctxRef.invoke<FenceDto[]>("fence_list");
      renderFences(fences);
    } catch (e2) {
      console.error(e2);
      const root = rootEl?.querySelector("#fences");
      if (root) {
        root.innerHTML = `<div class="fence"><div class="fence-title">围栏</div><p style="font-size:11px;color:#6b7a8c;padding:4px">无法接管桌面：${String(e)}</p></div>`;
      }
    }
  }
}

function syncEditButton() {
  const btn = rootEl?.querySelector("#editToggle") as HTMLElement | null;
  const on = editing();
  const hint = on ? "完成 (Win+Shift+D)" : "编辑 (Win+Shift+D)";
  if (btn) {
    btn.title = hint;
    btn.setAttribute("aria-label", hint);
  }
  if (on && fenceFilter) {
    clearFenceSearch();
  }
}

function wireGlobalKeys() {
  keyHandler = (e: KeyboardEvent) => {
    const active = document.activeElement;
    const inField = isTextField(active);
    const inSearch = active?.id === "fenceSearch";
    // Ctrl+K owned by cmdk; fence keeps /
    if (e.key === "/" && !inField) {
      e.preventDefault();
      focusFenceSearch();
      return;
    }
    if (e.key === "Escape") {
      if (fenceFilter.trim() || inSearch) {
        e.preventDefault();
        clearFenceSearch();
        if (inSearch) (active as HTMLInputElement).blur();
      }
      return;
    }
    if (!fenceFilter.trim()) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = getSearchRows();
      if (!rows.length) return;
      e.preventDefault();
      if (e.key === "ArrowDown") {
        searchSelectedIndex =
          searchSelectedIndex < 0 ? 0 : Math.min(searchSelectedIndex + 1, rows.length - 1);
      } else {
        searchSelectedIndex =
          searchSelectedIndex < 0 ? rows.length - 1 : Math.max(searchSelectedIndex - 1, 0);
      }
      updateSearchSelection(rows);
      return;
    }
    if (e.key === "Enter" && searchSelectedIndex >= 0 && (inSearch || !inField)) {
      const rows = getSearchRows();
      if (!rows.length) return;
      e.preventDefault();
      launchSelectedSearchRow();
    }
  };
  document.addEventListener("keydown", keyHandler);
}

const panel: PluginModule = {
  async mount(el, ctx) {
    rootEl = el;
    ctxRef = ctx;
    el.classList.add("pane-fences");
    el.innerHTML = `
      <div class="fences-toolbar">
        <div class="fences-head">
          <h2>全部图标 <span id="fenceCount" style="font-weight:400;opacity:.6"></span></h2>
          <div class="head-actions">
            <button type="button" class="icon-btn" id="autostartToggle" title="开机自启" aria-label="开机自启">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2.2v5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                <path d="M5.05 4.35a4.2 4.2 0 1 0 5.9 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </button>
            <button type="button" class="icon-btn" id="fenceRestore" title="还原到系统桌面" aria-label="还原到系统桌面">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.2 6.2A4.2 4.2 0 1 1 3.8 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                <path d="M4.2 3.2v3.2H7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button type="button" class="icon-btn" id="cmdkToggle" title="命令面板 (Ctrl+Shift+K)" aria-label="命令面板">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 4.5h10M3 8h7M3 11.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
            <button type="button" class="icon-btn" id="editToggle" title="编辑" aria-label="编辑">
              <svg class="ico-edit" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10.6 3.1 12.9 5.4 6.2 12.1H3.9v-2.3L10.6 3.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                <path d="M9.5 4.2 11.8 6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <svg class="ico-done" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.4 8.3 6.5 11.3 12.6 4.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
        <input type="text" class="fence-search" id="fenceSearch" placeholder="搜索图标…  /" autocomplete="off" spellcheck="false" />
      </div>
      <div id="fenceSearchResults" class="fence-search-results" hidden></div>
      <div id="fenceRecent" hidden></div>
      <div id="fences"></div>`;

    hideRecentBar();

    el.querySelector("#editToggle")?.addEventListener("click", () => toggleEditing());
    el.querySelector("#cmdkToggle")?.addEventListener("click", () => {
      (window as unknown as { __deskOpenCmdk?: () => void }).__deskOpenCmdk?.();
    });

    const autoBtn = el.querySelector("#autostartToggle") as HTMLElement | null;
    const syncAutostartBtn = async () => {
      if (!autoBtn || !ctxRef) return;
      try {
        const on = await ctxRef.invoke<boolean>("autostart_get");
        autoBtn.title = on ? "开机自启：开（点击关闭）" : "开机自启：关（点击开启）";
        autoBtn.setAttribute("aria-label", autoBtn.title);
        autoBtn.classList.toggle("on", on);
      } catch (e) {
        autoBtn.title = String(e);
        autoBtn.classList.remove("on");
      }
    };
    void syncAutostartBtn();
    autoBtn?.addEventListener("click", () => {
      void (async () => {
        if (!ctxRef) return;
        try {
          const cur = await ctxRef.invoke<boolean>("autostart_get");
          await ctxRef.invoke<boolean>("autostart_set", { enabled: !cur });
          await syncAutostartBtn();
        } catch (e) {
          alert(String(e));
        }
      })();
    });

    el.querySelector("#fenceRestore")?.addEventListener("click", () => {
      if (!confirm("把图标还原回系统桌面？") || !ctxRef) return;
      void ctxRef
        .invoke("fence_restore")
        .then(() => loadFences())
        .catch((e) => alert(String(e)));
    });

    const fenceSearch = el.querySelector("#fenceSearch") as HTMLInputElement | null;
    fenceSearch?.addEventListener("input", (e) => {
      fenceFilter = (e.target as HTMLInputElement).value;
      searchSelectedIndex = -1;
      applyFenceFilter();
    });
    fenceSearch?.addEventListener("compositionend", () => {
      if (fenceSearch) fenceFilter = fenceSearch.value;
      applyFenceFilter();
    });
    fenceSearch?.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void setTextInputActive(true);
    });
    fenceSearch?.addEventListener("focus", () => void setTextInputActive(true));
    fenceSearch?.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!isTextField(document.activeElement)) void setTextInputActive(false);
      }, 0);
    });

    unsubEdit = ctx.onEditChange(() => syncEditButton());
    syncEditButton();
    wireGlobalKeys();

    ctx.registerCommand({
      id: "restore",
      title: "还原图标到桌面",
      group: "围栏",
      run: () => {
        if (!confirm("把图标还原回系统桌面？") || !ctxRef) return;
        void ctxRef.invoke("fence_restore").then(() => loadFences());
      },
    });

    // Expose focus for cmdk search
    (window as unknown as { __deskFocusFenceSearch?: () => void }).__deskFocusFenceSearch =
      focusFenceSearch;

    void loadFences();
    setEditing(false);
  },
  onEditChange() {
    syncEditButton();
  },
  unmount() {
    unsubEdit?.();
    unsubEdit = null;
    if (keyHandler) document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
    delete (window as unknown as { __deskFocusFenceSearch?: () => void }).__deskFocusFenceSearch;
    rootEl = null;
    ctxRef = null;
  },
};

export function getRecentLaunchCommands(): Array<{
  id: string;
  title: string;
  path: string;
}> {
  return getQuickBarItems().map((i) => ({
    id: i.id,
    title: i.label,
    path: i.path,
  }));
}

export default panel;
