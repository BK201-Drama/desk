import { createHostContext, clearPluginCommands } from "./api";
import { emit } from "./events";
import type {
  BundledPlugin,
  PluginManifest,
  PluginModule,
  PluginsConfig,
  UserPluginInfo,
} from "./types";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type MountedPlugin = {
  manifest: PluginManifest;
  source: "bundled" | "user";
  root: HTMLElement;
  mod: PluginModule;
  ctx: ReturnType<typeof createHostContext>;
  unsubs: Array<() => void>;
};

const mounted = new Map<string, MountedPlugin>();

function slotEl(slot: string): HTMLElement | null {
  return document.getElementById(`slot-${slot}`);
}

function ensureMountRoot(slot: string, id: string, order: number): HTMLElement {
  const parent = slotEl(slot);
  if (!parent) throw new Error(`missing slot-${slot}`);
  let root = parent.querySelector<HTMLElement>(`[data-plugin="${id}"]`);
  if (!root) {
    root = document.createElement("div");
    root.dataset.plugin = id;
    root.className = `plugin-root plugin-${id}`;
    root.style.order = String(order);
    if (slot === "overlay") {
      root.classList.add("plugin-overlay-root");
    }
    parent.appendChild(root);
  } else {
    root.style.order = String(order);
  }
  return root;
}

async function loadCss(href: string, id: string) {
  const existing = document.getElementById(`plugin-css-${id}`);
  if (existing) return;
  const link = document.createElement("link");
  link.id = `plugin-css-${id}`;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

async function mountOne(
  manifest: PluginManifest,
  mod: PluginModule,
  source: "bundled" | "user",
  cssHref?: string | null
): Promise<void> {
  if (mounted.has(manifest.id)) {
    await unmountOne(manifest.id);
  }
  const order = manifest.order ?? 100;
  const root = ensureMountRoot(manifest.slot, manifest.id, order);
  root.innerHTML = "";
  if (cssHref) {
    await loadCss(cssHref, manifest.id);
  }
  const ctx = createHostContext(manifest);
  const unsubs: Array<() => void> = [];
  if (mod.onEditChange) {
    unsubs.push(ctx.onEditChange((on) => mod.onEditChange?.(on)));
  }
  try {
    await mod.mount(root, ctx);
    mounted.set(manifest.id, { manifest, source, root, mod, ctx, unsubs });
    emit("plugin:mounted", { id: manifest.id, slot: manifest.slot, source }, "host");
  } catch (e) {
    console.error(`plugin mount failed: ${manifest.id}`, e);
    emit(
      "plugin:error",
      { id: manifest.id, phase: "mount", error: String(e) },
      "host"
    );
    root.innerHTML = `<div class="plugin-error" title="${String(e)}">插件 ${manifest.id} 加载失败</div>`;
  }
}

export async function unmountOne(id: string): Promise<void> {
  const m = mounted.get(id);
  if (!m) return;
  for (const u of m.unsubs) u();
  clearPluginCommands(id);
  try {
    await m.mod.unmount?.();
  } catch (e) {
    console.error(`plugin unmount failed: ${id}`, e);
  }
  m.root.remove();
  document.getElementById(`plugin-css-${id}`)?.remove();
  mounted.delete(id);
  emit("plugin:unmounted", { id }, "host");
}

export function listMounted(): MountedPlugin[] {
  return [...mounted.values()];
}

export async function loadAll(bundled: BundledPlugin[]): Promise<void> {
  let config: PluginsConfig = {
    active_preset: "coder",
    disabled: ["hello", "ops-hud", "event-tape"],
  };
  try {
    config = await invoke<PluginsConfig>("plugin_get_config");
  } catch (e) {
    console.warn("plugin_get_config", e);
  }
  const disabled = new Set(config.disabled ?? []);

  // User plugins override bundled with same id
  let users: UserPluginInfo[] = [];
  try {
    users = await invoke<UserPluginInfo[]>("plugin_list_user");
  } catch (e) {
    console.warn("plugin_list_user", e);
  }

  /** only skip bundled when a user plugin with same id actually mounted */
  const mountedUserIds = new Set<string>();

  for (const u of users) {
    if (disabled.has(u.id)) {
      emit("plugin:skipped", { id: u.id, reason: "disabled" }, "host");
      continue;
    }
    try {
      if (u.css_path) {
        await loadCss(convertFileSrc(u.css_path), u.id);
      }
      const url = convertFileSrc(u.entry_path);
      const mod = (await import(/* @vite-ignore */ url)) as PluginModule & {
        default?: PluginModule;
      };
      const panel = mod.default ?? mod;
      await mountOne(u.manifest, panel, "user", null);
      mountedUserIds.add(u.id);
    } catch (e) {
      console.error("user plugin load", u.id, e);
      emit(
        "plugin:error",
        { id: u.id, phase: "import", error: String(e) },
        "host"
      );
    }
  }

  const sorted = [...bundled].sort(
    (a, b) => (a.manifest.order ?? 100) - (b.manifest.order ?? 100)
  );
  for (const b of sorted) {
    if (mountedUserIds.has(b.manifest.id)) continue;
    if (disabled.has(b.manifest.id)) {
      emit("plugin:skipped", { id: b.manifest.id, reason: "disabled" }, "host");
      continue;
    }
    try {
      const mod = await b.load();
      await mountOne(b.manifest, mod, "bundled");
    } catch (e) {
      console.error("bundled plugin load", b.manifest.id, e);
      emit(
        "plugin:error",
        { id: b.manifest.id, phase: "import", error: String(e) },
        "host"
      );
    }
  }

  emit(
    "plugin:ready",
    {
      mounted: [...mounted.keys()],
      disabled: [...disabled],
      preset: config.active_preset ?? "coder",
    },
    "host"
  );
}

export async function setPluginDisabled(id: string, disabled: boolean): Promise<void> {
  await invoke("plugin_set_disabled", { id, disabled });
}

export async function reloadPlugins(bundled: BundledPlugin[]): Promise<void> {
  for (const id of [...mounted.keys()]) {
    await unmountOne(id);
  }
  await loadAll(bundled);
}
