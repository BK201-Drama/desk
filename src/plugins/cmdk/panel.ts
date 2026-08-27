import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { HostCommand, HostContext, PluginModule, PresetInfo } from "../../host/types";
import { listCommands } from "../../host/api";
import { escapeHtml } from "../../host/util";
import { toggleEditing } from "../../host/edit";
import { setPluginDisabled, listMounted } from "../../host/registry";
import { listPresets } from "../../host/presets";
import "./panel.css";

type DeskHostBridge = {
  reloadPlugins?: () => Promise<void>;
  applyPreset?: (id: string) => Promise<void>;
  saveCustom?: () => Promise<void>;
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

async function setKeyboard(active: boolean) {
  if (!ctxRef) return;
  try {
    await ctxRef.invoke("set_keyboard_input", { active });
    if (active) await getCurrentWindow().setFocus();
  } catch {
    /* ignore */
  }
}

function collectCommands(): HostCommand[] {
  const cmds = listCommands();
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
      title: "重载全部插件",
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
      title: "保存当前为自定义布局",
      group: "布局",
      run: async () => {
        await bridge().saveCustom?.();
      },
    },
  ];

  for (const p of presetCache) {
    const mark = p.id === "coder" ? " ← 默认" : "";
    extras.push({
      id: `host:preset:${p.id}`,
      title: `布局 · ${p.name}${mark}`,
      hint: p.description,
      group: "布局",
      run: async () => {
        await bridge().applyPreset?.(p.id);
        try {
          presetCache = await listPresets();
        } catch {
          /* ignore */
        }
      },
    });
  }

  for (const m of listMounted()) {
    const id = m.manifest.id;
    if (id === "cmdk") continue;
    extras.push({
      id: `host:disable:${id}`,
      title: `禁用插件 · ${m.manifest.name}`,
      group: "Plugins",
      run: async () => {
        await setPluginDisabled(id, true);
        await bridge().reloadPlugins?.();
        try {
          presetCache = await listPresets();
        } catch {
          /* ignore */
        }
      },
    });
  }

  for (const id of [
    "clock",
    "github",
    "multica",
    "remind",
    "fence",
    "qq-music",
    "ops-hud",
    "event-tape",
    "hello",
  ]) {
    extras.push({
      id: `host:enable:${id}`,
      title: `启用插件 · ${id}`,
      group: "Plugins",
      run: async () => {
        await setPluginDisabled(id, false);
        await bridge().reloadPlugins?.();
        try {
          presetCache = await listPresets();
        } catch {
          /* ignore */
        }
      },
    });
  }

  const seen = new Set<string>();
  const out: HostCommand[] = [];
  for (const c of [...extras, ...cmds]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function filtered(): HostCommand[] {
  const q = filter.trim().toLowerCase();
  const all = collectCommands();
  if (!q) return all;
  return all.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      (c.group ?? "").toLowerCase().includes(q)
  );
}

function renderList() {
  if (!root) return;
  const items = filtered();
  if (selected >= items.length) selected = Math.max(0, items.length - 1);
  const list = root.querySelector(".cmdk-list");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<div class="cmdk-empty">无匹配命令</div>`;
    return;
  }
  list.innerHTML = items
    .map((c, i) => {
      const sel = i === selected ? " is-selected" : "";
      return `<button type="button" class="cmdk-item${sel}" data-idx="${i}">
        <span class="cmdk-title">${escapeHtml(c.title)}</span>
        <span class="cmdk-meta">${escapeHtml(c.group ?? "")}${c.hint ? ` · ${escapeHtml(c.hint)}` : ""}</span>
      </button>`;
    })
    .join("");
  list.querySelectorAll<HTMLButtonElement>(".cmdk-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      selected = idx;
      void runSelected();
    });
  });
  list.querySelector(".cmdk-item.is-selected")?.scrollIntoView({ block: "nearest" });
}

function setOpen(next: boolean) {
  open = next;
  root?.classList.toggle("show", open);
  const input = root?.querySelector(".cmdk-input") as HTMLInputElement | null;
  if (open) {
    filter = "";
    selected = 0;
    void setKeyboard(true);
    void listPresets()
      .then((p) => {
        presetCache = p;
        renderList();
      })
      .catch(() => renderList());
    if (input) {
      input.value = "";
      // defer focus until keyboard mode is on
      window.setTimeout(() => input.focus(), 30);
    }
  } else {
    void setKeyboard(false);
  }
}

async function runSelected() {
  const items = filtered();
  const cmd = items[selected];
  if (!cmd) return;
  setOpen(false);
  try {
    await cmd.run();
  } catch (e) {
    console.error(e);
    alert(String(e));
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
          <input class="cmdk-input" type="text" placeholder="命令… Ctrl+Shift+K" autocomplete="off" spellcheck="false" />
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
      const items = filtered();
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
        void runSelected();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    });

    keyHandler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // Local fallback when board already has focus
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

    // Mouse fallback from fence toolbar
    (window as unknown as { __deskOpenCmdk?: () => void }).__deskOpenCmdk = () =>
      setOpen(true);

    try {
      presetCache = await listPresets();
    } catch (e) {
      console.warn("listPresets", e);
    }

    ctx.registerCommand({
      id: "open",
      title: "打开命令面板",
      hint: "Ctrl+Shift+K",
      group: "Desk",
      run: () => setOpen(true),
    });
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
