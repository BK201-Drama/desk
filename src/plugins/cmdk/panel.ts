import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { HostCommand, HostContext, PluginModule, PresetInfo } from "../../host/types";
import { listCommands } from "../../host/api";
import { escapeHtml } from "../../host/util";
import { toggleEditing } from "../../host/edit";
import { getConfig, listPresets } from "../../host/presets";
import "./panel.css";

type DeskHostBridge = {
  reloadPlugins?: () => Promise<void>;
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<void>;
  applyPreset?: (id: string) => Promise<void>;
  saveCustom?: () => Promise<void>;
};

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
let toggling = false;

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
  } catch {
    /* ignore */
  }
}

function collectCommands(): HostCommand[] {
  const cmds = listCommands().filter((c) => c.id !== "cmdk:open" && c.id !== "open");
  const extras: HostCommand[] = [
    {
      id: "host:toggle-edit",
      title: "切换编辑模式",
      hint: "Win+Shift+D",
      group: "Desk",
      run: () => toggleEditing(),
    },
    {
      id: "host:reload-plugins",
      title: "重载插件",
      group: "Desk",
      run: async () => {
        await bridge().reloadPlugins?.();
      },
    },
    {
      id: "host:focus-fence-search",
      title: "搜索桌面图标",
      hint: "/",
      group: "Desk",
      run: () => {
        (
          window as unknown as { __deskFocusFenceSearch?: () => void }
        ).__deskFocusFenceSearch?.();
      },
    },
    {
      id: "host:save-custom",
      title: "保存为自定义",
      group: "布局",
      run: async () => {
        await bridge().saveCustom?.();
      },
    },
  ];

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
      },
    });
  }

  const seen = new Set<string>();
  const out: HostCommand[] = [];
  for (const c of [...extras, ...cmds]) {
    if (seen.has(c.id)) continue;
    // 旧的 打开/关闭 命令不再出现
    if (c.id.startsWith("host:enable:") || c.id.startsWith("host:disable:")) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function collectNav(): NavItem[] {
  const q = filter.trim().toLowerCase();
  const items: NavItem[] = [];

  for (const cmd of collectCommands()) {
    if (
      q &&
      !cmd.title.toLowerCase().includes(q) &&
      !cmd.id.toLowerCase().includes(q) &&
      !(cmd.group ?? "").toLowerCase().includes(q) &&
      !(cmd.hint ?? "").toLowerCase().includes(q)
    ) {
      continue;
    }
    items.push({ kind: "cmd", group: cmd.group || "其他", cmd });
  }

  for (const [id, title] of Object.entries(PLUGIN_LABEL)) {
    if (
      q &&
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
    btn.addEventListener("click", () => {
      selected = Number(btn.dataset.idx);
      void activateSelected();
    });
  });
  list.querySelector(".cmdk-item.is-selected")?.scrollIntoView({ block: "nearest" });
}

async function togglePlugin(id: string, nextOn: boolean) {
  if (toggling) return;
  toggling = true;
  try {
    // 乐观更新，开关立刻翻
    if (nextOn) disabledIds.delete(id);
    else disabledIds.add(id);
    renderList();
    // 只挂载/卸载这一个，其它面板不重载
    const enable = bridge().setPluginEnabled;
    if (!enable) throw new Error("setPluginEnabled unavailable");
    await enable(id, nextOn);
    await refreshMeta();
    renderList();
  } catch (e) {
    console.error(e);
    await refreshMeta();
    renderList();
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
    void refreshMeta().then(() => renderList());
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
          <input class="cmdk-input" type="text" placeholder="搜索命令" autocomplete="off" spellcheck="false" />
          <kbd>esc</kbd>
        </div>
        <div class="cmdk-list"></div>
      </div>`;

    el.querySelector(".cmdk-backdrop")?.addEventListener("click", () => setOpen(false));
    const input = el.querySelector(".cmdk-input") as HTMLInputElement;
    input.addEventListener("input", () => {
      filter = input.value;
      selected = 0;
      renderList();
    });
    input.addEventListener("keydown", (e) => {
      const items = collectNav();
      if (e.key === "ArrowDown") {
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
