import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { HostCommand, HostContext, PluginModule, PresetInfo } from "../../host/types";
import { listCommands } from "../../host/api";
import { escapeHtml } from "../../host/util";
import { toggleEditing } from "../../host/edit";
import { getConfig, listPresets } from "../../host/presets";
import {
  chipLabel,
  enabledIds,
  hasCustomDraft,
  hasCustomSaved,
  PRESET_LABEL,
  savedEnabledIds,
  schemeName,
} from "../../host/layout-util";
import { showToast } from "../../host/toast";
import type { PluginsConfig } from "../../host/types";
import "./panel.css";

type DeskHostBridge = {
  reloadPlugins?: () => Promise<void>;
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<void>;
  movePlugin?: (id: string, dir: -1 | 1) => Promise<void>;
  applyPreset?: (id: string) => Promise<void>;
  saveCustom?: (name?: string) => Promise<void>;
  discardCustom?: () => Promise<void>;
};

const MAIN_PLUGINS = ["github", "multica", "remind", "fence", "qq-music", "clock"] as const;
const EXTENDED_PLUGINS = ["ops-hud", "event-tape", "hello"] as const;

const PLUGIN_LABEL: Record<string, string> = {
  github: "GitHub",
  multica: "Multica",
  remind: "待办",
  fence: "围栏",
  "qq-music": "QQ 音乐",
  clock: "时钟",
  "ops-hud": "运维 HUD",
  "event-tape": "事件磁带",
  hello: "Hello",
};

function bridge(): DeskHostBridge {
  return (window as unknown as { __deskHost?: DeskHostBridge }).__deskHost ?? {};
}

let root: HTMLElement | null = null;
let ctxRef: HostContext | null = null;
let open = false;
let filter = "";
let selected = 0;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let unsubs: Array<() => void> = [];
let presetCache: PresetInfo[] = [];
let disabledIds = new Set<string>();
let activePreset = "coder";
let layoutCfg: PluginsConfig | null = null;
let toggling = false;
let moving = false;

const QUICK_PRESETS = [
  { id: "coder", label: "程序员" },
  { id: "minimal", label: "极简" },
  { id: "fence", label: "围栏" },
] as const;

type NavItem =
  | { kind: "cmd"; group: string; cmd: HostCommand }
  | { kind: "plugin"; group: "插件"; id: string; title: string; on: boolean };

async function setKeyboard(active: boolean) {
  if (!ctxRef) return;
  try {
    await ctxRef.invoke("set_keyboard_input", { active });
    if (active) await getCurrentWindow().setFocus();
  } catch {
    /* ignore */
  }
}

async function refreshMeta() {
  try {
    presetCache = await listPresets();
  } catch {
    /* ignore */
  }
  try {
    const cfg = await getConfig();
    disabledIds = new Set(cfg.disabled ?? []);
    activePreset = cfg.active_preset || "coder";
    layoutCfg = cfg;
  } catch {
    /* ignore */
  }
}

function collectCommands(searching: boolean): HostCommand[] {
  const cmds = listCommands().filter((c) => c.id !== "cmdk:open" && c.id !== "open");
  const extras: HostCommand[] = [
    {
      id: "host:toggle-edit",
      title: "切换编辑模式",
      hint: "Win+Shift+D",
      group: "Desk",
      run: () => toggleEditing(),
    },
  ];

  if (searching) {
    extras.push({
      id: "host:reload-plugins",
      title: "重载插件",
      group: "Desk",
      run: async () => {
        await bridge().reloadPlugins?.();
      },
    });
    extras.push({
      id: "host:focus-fence-search",
      title: "搜索桌面图标",
      hint: "/",
      group: "Desk",
      run: () => {
        (
          window as unknown as { __deskFocusFenceSearch?: () => void }
        ).__deskFocusFenceSearch?.();
      },
    });
    for (const p of presetCache) {
      const mark = p.id === "coder" ? " · 默认" : "";
      extras.push({
        id: `host:preset:${p.id}`,
        title: `${p.name}${mark}`,
        hint: p.description,
        group: "布局",
        run: async () => {
          await bridge().applyPreset?.(p.id);
          await refreshMeta();
          renderAll();
        },
      });
    }
  }

  const seen = new Set<string>();
  const out: HostCommand[] = [];
  for (const c of [...extras, ...(searching ? cmds : [])]) {
    if (seen.has(c.id)) continue;
    if (c.id.startsWith("host:enable:") || c.id.startsWith("host:disable:")) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function collectNav(): NavItem[] {
  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;
  const items: NavItem[] = [];

  for (const cmd of collectCommands(searching)) {
    if (
      searching &&
      !cmd.title.toLowerCase().includes(q) &&
      !cmd.id.toLowerCase().includes(q) &&
      !(cmd.group ?? "").toLowerCase().includes(q) &&
      !(cmd.hint ?? "").toLowerCase().includes(q)
    ) {
      continue;
    }
    items.push({ kind: "cmd", group: cmd.group || "其他", cmd });
  }

  const pluginIds = searching
    ? Object.keys(PLUGIN_LABEL)
    : [...MAIN_PLUGINS, ...EXTENDED_PLUGINS.filter((id) => !disabledIds.has(id))];

  for (const id of pluginIds) {
    const title = PLUGIN_LABEL[id];
    if (!title) continue;
    if (
      searching &&
      !title.toLowerCase().includes(q) &&
      !id.toLowerCase().includes(q) &&
      !"插件".includes(q)
    ) {
      continue;
    }
    items.push({
      kind: "plugin",
      group: "插件",
      id,
      title,
      on: !disabledIds.has(id),
    });
  }

  return items;
}

type ListRow =
  | { kind: "head"; label: string }
  | { kind: "item"; item: NavItem; index: number };

function buildRows(items: NavItem[]): ListRow[] {
  const rows: ListRow[] = [];
  let lastGroup = "";
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      rows.push({ kind: "head", label: item.group });
      lastGroup = item.group;
    }
    rows.push({ kind: "item", item, index });
  });
  return rows;
}

function switchHtml(on: boolean) {
  return `<span class="cmdk-switch${on ? " is-on" : ""}" aria-hidden="true"><span class="cmdk-switch-knob"></span></span>`;
}

function orderControlsHtml(id: string, on: boolean) {
  if (!on || id === "cmdk") return "";
  return `<span class="cmdk-order" data-plugin-order="${escapeHtml(id)}">
    <button type="button" class="cmdk-order-btn" data-move="-1" title="上移 (Alt+↑)">↑</button>
    <button type="button" class="cmdk-order-btn" data-move="1" title="下移 (Alt+↓)">↓</button>
  </span>`;
}

function chipsHtml(ids: string[], emptyText: string) {
  if (!ids.length) {
    return `<span class="cmdk-chip empty">${escapeHtml(emptyText)}</span>`;
  }
  return ids
    .map((id) => `<span class="cmdk-chip">${escapeHtml(chipLabel(id))}</span>`)
    .join('<span class="cmdk-chip-sep">›</span>');
}

async function applyPresetId(id: string) {
  await bridge().applyPreset?.(id);
  await refreshMeta();
  if (id === "custom") showToast(`已应用「${layoutCfg ? schemeName(layoutCfg) : "我的方案"}」`);
  else showToast(`已切到${PRESET_LABEL[id] ?? id}`);
  renderAll();
}

async function saveScheme() {
  const input = root?.querySelector<HTMLInputElement>(".cmdk-scheme-name");
  const name = input?.value.trim();
  await bridge().saveCustom?.(name || undefined);
  await refreshMeta();
  showToast(`方案已保存${name ? `：${name}` : ""}`);
  renderAll();
}

async function discardScheme() {
  const hadSaved = layoutCfg != null && hasCustomSaved(layoutCfg);
  await bridge().discardCustom?.();
  await refreshMeta();
  showToast(hadSaved ? "已恢复为上次保存的方案" : "已恢复为程序员布局");
  renderAll();
}

async function applySavedScheme() {
  if (!layoutCfg || !hasCustomSaved(layoutCfg)) return;
  await applyPresetId("custom");
}

function renderComposer() {
  const composer = root?.querySelector(".cmdk-composer");
  if (!composer || filter.trim()) {
    composer?.classList.add("hidden");
    return;
  }
  composer.classList.remove("hidden");
  if (!layoutCfg) {
    composer.innerHTML = "";
    return;
  }

  const saved = hasCustomSaved(layoutCfg);
  const draft = hasCustomDraft(layoutCfg);
  const currentBlocks = enabledIds(layoutCfg);
  const savedBlocks = saved ? savedEnabledIds(layoutCfg) : [];
  const name = schemeName(layoutCfg);

  const status = draft
    ? `<span class="cmdk-scheme-status is-draft">● 有未保存改动</span>`
    : saved
      ? `<span class="cmdk-scheme-status is-saved">✓ 已保存</span>`
      : `<span class="cmdk-scheme-status">在下面开关插件，然后保存</span>`;

  const pills = [
    ...QUICK_PRESETS.map(
      (p) =>
        `<button type="button" class="cmdk-preset-pill${activePreset === p.id ? " is-active" : ""}" data-preset="${p.id}">${p.label}</button>`
    ),
    saved
      ? `<button type="button" class="cmdk-preset-pill cmdk-preset-pill-custom${activePreset === "custom" && !draft ? " is-active" : ""}" data-preset="custom">${escapeHtml(name)}</button>`
      : "",
  ].join("");

  const savedTrack =
    saved && draft
      ? `<div class="cmdk-scheme-saved">
          <span class="cmdk-scheme-sublabel">已保存</span>
          <div class="cmdk-composer-track is-dim">${chipsHtml(savedBlocks, "空")}</div>
        </div>`
      : "";

  composer.innerHTML = `
    <div class="cmdk-scheme-card">
      <div class="cmdk-scheme-head">
        <span class="cmdk-composer-label">我的方案</span>
        <input class="cmdk-scheme-name" type="text" value="${escapeHtml(name === "我的方案" ? "" : name)}" placeholder="给方案起个名（可选）" maxlength="24" />
      </div>
      <div class="cmdk-scheme-edit">
        <span class="cmdk-scheme-sublabel">${draft || !saved ? "正在编辑" : "当前"}</span>
        <div class="cmdk-composer-track">${chipsHtml(currentBlocks, "还没有面板，下面打开插件")}</div>
      </div>
      ${savedTrack}
      ${status}
      <div class="cmdk-scheme-actions">
        <button type="button" class="cmdk-scheme-btn primary" data-action="save">保存方案</button>
        <button type="button" class="cmdk-scheme-btn" data-action="apply"${saved ? "" : " disabled"}>应用已保存</button>
        <button type="button" class="cmdk-scheme-btn" data-action="discard"${draft ? "" : " disabled"}>放弃改动</button>
      </div>
      <div class="cmdk-builtin-row">
        <span class="cmdk-builtin-label">内置</span>
        <div class="cmdk-preset-pills">${pills}</div>
      </div>
    </div>`;

  composer.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void applyPresetId(btn.dataset.preset!);
    });
  });
  composer.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    void saveScheme();
  });
  composer.querySelector<HTMLButtonElement>('[data-action="apply"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    void applySavedScheme();
  });
  composer.querySelector<HTMLButtonElement>('[data-action="discard"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    void discardScheme();
  });
  composer.querySelector<HTMLInputElement>(".cmdk-scheme-name")?.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  composer.querySelector<HTMLInputElement>(".cmdk-scheme-name")?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void saveScheme();
    }
  });
}

function renderAll() {
  renderComposer();
  renderList();
}

function renderList() {
  if (!root) return;
  const items = collectNav();
  if (selected >= items.length) selected = Math.max(0, items.length - 1);
  const list = root.querySelector(".cmdk-list");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<div class="cmdk-empty">无匹配</div>`;
    return;
  }
  const rows = buildRows(items);
  list.innerHTML = rows
    .map((row) => {
      if (row.kind === "head") {
        return `<div class="cmdk-section">${escapeHtml(row.label)}</div>`;
      }
      const sel = row.index === selected ? " is-selected" : "";
      if (row.item.kind === "plugin") {
        return `<button type="button" class="cmdk-item cmdk-item-row${sel}" data-idx="${row.index}">
          <span class="cmdk-title">${escapeHtml(row.item.title)}</span>
          ${orderControlsHtml(row.item.id, row.item.on)}
          ${switchHtml(row.item.on)}
        </button>`;
      }
      const meta = row.item.cmd.hint ? escapeHtml(row.item.cmd.hint) : "";
      return `<button type="button" class="cmdk-item${sel}" data-idx="${row.index}">
        <span class="cmdk-title">${escapeHtml(row.item.cmd.title)}</span>
        ${meta ? `<span class="cmdk-meta">${meta}</span>` : ""}
      </button>`;
    })
    .join("");

  list.querySelectorAll<HTMLButtonElement>(".cmdk-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".cmdk-order-btn")) return;
      selected = Number(btn.dataset.idx);
      void activateSelected();
    });
  });
  list.querySelectorAll<HTMLButtonElement>(".cmdk-order-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest("[data-plugin-order]") as HTMLElement | null;
      const id = wrap?.dataset.pluginOrder;
      const dir = Number(btn.dataset.move) as -1 | 1;
      if (!id || (dir !== -1 && dir !== 1)) return;
      void movePlugin(id, dir);
    });
  });
  list.querySelector(".cmdk-item.is-selected")?.scrollIntoView({ block: "nearest" });
}

async function movePlugin(id: string, dir: -1 | 1) {
  if (moving) return;
  moving = true;
  try {
    const fn = bridge().movePlugin;
    if (!fn) throw new Error("movePlugin unavailable");
    await fn(id, dir);
    await refreshMeta();
    renderAll();
  } catch (e) {
    console.error(e);
    await refreshMeta();
    renderAll();
    alert(String(e));
  } finally {
    moving = false;
  }
}

async function togglePlugin(id: string, nextOn: boolean) {
  if (toggling) return;
  toggling = true;
  try {
    // 乐观更新，开关立刻翻
    if (nextOn) disabledIds.delete(id);
    else disabledIds.add(id);
    renderAll();
    const enable = bridge().setPluginEnabled;
    if (!enable) throw new Error("setPluginEnabled unavailable");
    await enable(id, nextOn);
    await refreshMeta();
    renderAll();
  } catch (e) {
    console.error(e);
    await refreshMeta();
    renderAll();
    alert(String(e));
  } finally {
    toggling = false;
  }
}

async function activateSelected() {
  const items = collectNav();
  const item = items[selected];
  if (!item) return;
  if (item.kind === "plugin") {
    await togglePlugin(item.id, !item.on);
    return; // 保持面板打开，方便连开几个
  }
  setOpen(false);
  try {
    await item.cmd.run();
  } catch (e) {
    console.error(e);
    alert(String(e));
  }
}

function setOpen(next: boolean) {
  open = next;
  root?.classList.toggle("show", open);
  const input = root?.querySelector(".cmdk-input") as HTMLInputElement | null;
  if (open) {
    filter = "";
    selected = 0;
    void setKeyboard(true);
    void refreshMeta().then(() => renderAll());
    if (input) {
      input.value = "";
      window.setTimeout(() => input.focus(), 30);
    }
  } else {
    void setKeyboard(false);
  }
}

const panel: PluginModule = {
  async mount(el, ctx) {
    root = el;
    ctxRef = ctx;
    el.innerHTML = `
      <div class="cmdk-backdrop"></div>
      <div class="cmdk-panel" role="dialog" aria-label="命令面板">
        <div class="cmdk-head">
          <span class="cmdk-prompt">›</span>
          <input class="cmdk-input" type="text" placeholder="布局 / 插件 / 搜索更多…" autocomplete="off" spellcheck="false" />
          <kbd>esc</kbd>
        </div>
        <div class="cmdk-composer hidden"></div>
        <div class="cmdk-list"></div>
      </div>`;

    el.querySelector(".cmdk-backdrop")?.addEventListener("click", () => setOpen(false));
    const input = el.querySelector(".cmdk-input") as HTMLInputElement;
    input.addEventListener("input", () => {
      filter = input.value;
      selected = 0;
      renderAll();
    });
    input.addEventListener("keydown", (e) => {
      const items = collectNav();
      if (
        e.altKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        e.preventDefault();
        const item = items[selected];
        if (item?.kind === "plugin" && item.on) {
          void movePlugin(item.id, e.key === "ArrowUp" ? -1 : 1);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        selected = Math.min(selected + 1, Math.max(0, items.length - 1));
        renderList();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selected = Math.max(selected - 1, 0);
        renderList();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void activateSelected();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    });

    keyHandler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
        return;
      }
      if (open && e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", keyHandler);

    unsubs.push(
      await listen("desk:open-cmdk", () => {
        setOpen(true);
      })
    );

    (window as unknown as { __deskOpenCmdk?: () => void }).__deskOpenCmdk = () =>
      setOpen(true);

    await refreshMeta();
  },
  unmount() {
    for (const u of unsubs) u();
    unsubs = [];
    if (keyHandler) document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
    delete (window as unknown as { __deskOpenCmdk?: () => void }).__deskOpenCmdk;
    root = null;
    ctxRef = null;
  },
};

export default panel;
