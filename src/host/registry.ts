import { createHostContext, clearPluginCommands } from "./api";
import { emit } from "./events";
import { isEditing } from "./edit";
import { setMountEntries } from "./mount-store";
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
  mod: PluginModule;
  ctx: ReturnType<typeof createHostContext>;
  order: number;
  error?: string;
  unsubs: Array<() => void>;
};

type DesiredPlugin = {
  manifest: PluginManifest;
  source: "bundled" | "user";
  load: () => Promise<PluginModule>;
  cssHref?: string | null;
};

const mounted = new Map<string, MountedPlugin>();

function publishMountStore(): void {
  setMountEntries(
    [...mounted.values()].map((m) => ({
      manifest: m.manifest,
      source: m.source,
      mod: m.mod,
      ctx: m.ctx,
      order: m.order,
      error: m.error,
    }))
  );
}

function slotEl(slot: string): HTMLElement | null {
  return document.getElementById(`slot-${slot}`);
}

/** config.order 优先；未出现的用 manifest.order + 1000 垫底 */
export function effectiveSortKey(
  id: string,
  manifestOrder: number | undefined,
  configOrder: string[]
): number {
  const i = configOrder.indexOf(id);
  if (i >= 0) return i;
  return 1000 + (manifestOrder ?? 100);
}

export function applyDomOrders(entries: Array<{ id: string; order: number }>): void {
  for (const { id, order } of entries) {
    const m = mounted.get(id);
    if (m) m.order = order;
    const el = document.querySelector<HTMLElement>(`[data-plugin="${id}"]`);
    if (el) el.style.order = String(order);
  }
  publishMountStore();
}

export function applyOrderList(order: string[]): void {
  order.forEach((id, i) => {
    const next = i * 10;
    const m = mounted.get(id);
    if (m) m.order = next;
    const el = document.querySelector<HTMLElement>(`[data-plugin="${id}"]`);
    if (el) el.style.order = String(next);
  });
  publishMountStore();
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
  cssHref: string | null | undefined,
  cssOrder: number
): Promise<void> {
  if (mounted.has(manifest.id)) {
    await unmountOne(manifest.id);
  }
  if (cssHref) {
    await loadCss(cssHref, manifest.id);
  }
  const ctx = createHostContext(manifest);
  const unsubs: Array<() => void> = [];
  if (mod.onEditChange) {
    unsubs.push(ctx.onEditChange((on) => mod.onEditChange?.(on)));
  }

  if (!mod.Component && !mod.mount) {
    const error = `plugin ${manifest.id}: no Component or mount()`;
    console.error(error);
    mounted.set(manifest.id, {
      manifest,
      source,
      mod,
      ctx,
      order: cssOrder,
      error,
      unsubs,
    });
    publishMountStore();
    emit("plugin:error", { id: manifest.id, phase: "mount", error }, "host");
    return;
  }

  mounted.set(manifest.id, {
    manifest,
    source,
    mod,
    ctx,
    order: cssOrder,
    unsubs,
  });
  publishMountStore();
  emit("plugin:mounted", { id: manifest.id, slot: manifest.slot, source }, "host");

  // 编辑态拖拽 class 由 Board 根据 useEditing 渲染；此处同步一次 DOM 兜底
  if (manifest.slot === "left" && isEditing()) {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-plugin="${manifest.id}"]`);
      if (el) {
        el.draggable = true;
        el.classList.add("plugin-reorderable");
      }
    });
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
  document.getElementById(`plugin-css-${id}`)?.remove();
  mounted.delete(id);
  publishMountStore();
  emit("plugin:unmounted", { id }, "host");
}

export function listMounted(): MountedPlugin[] {
  return [...mounted.values()];
}

/** 同槽内当前显示顺序（已挂载） */
export function listSlotOrder(slot: string): string[] {
  const fromStore = [...mounted.values()]
    .filter((m) => m.manifest.slot === slot)
    .sort((a, b) => a.order - b.order || a.manifest.id.localeCompare(b.manifest.id))
    .map((m) => m.manifest.id);
  if (fromStore.length) return fromStore;

  const parent = slotEl(slot);
  if (!parent) return [];
  return [...parent.querySelectorAll<HTMLElement>(":scope > [data-plugin]")]
    .map((el) => ({
      id: el.dataset.plugin!,
      order: Number(el.style.order || 0),
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((x) => x.id);
}

async function readConfig(): Promise<PluginsConfig> {
  try {
    return await invoke<PluginsConfig>("plugin_get_config");
  } catch (e) {
    console.warn("plugin_get_config", e);
    return {
      active_preset: "coder",
      disabled: ["hello", "ops-hud", "event-tape"],
      order: [],
    };
  }
}

async function collectDesired(
  bundled: BundledPlugin[]
): Promise<{
  desired: Map<string, DesiredPlugin>;
  disabled: Set<string>;
  preset: string;
  order: string[];
}> {
  const config = await readConfig();
  const disabled = new Set(config.disabled ?? []);
  const order = config.order ?? [];
  const desired = new Map<string, DesiredPlugin>();

  let users: UserPluginInfo[] = [];
  try {
    users = await invoke<UserPluginInfo[]>("plugin_list_user");
  } catch (e) {
    console.warn("plugin_list_user", e);
  }

  for (const u of users) {
    if (disabled.has(u.id)) {
      emit("plugin:skipped", { id: u.id, reason: "disabled" }, "host");
      continue;
    }
    const entryPath = u.entry_path;
    const cssPath = u.css_path;
    desired.set(u.id, {
      manifest: u.manifest,
      source: "user",
      cssHref: cssPath ? convertFileSrc(cssPath) : null,
      load: async () => {
        const url = convertFileSrc(entryPath);
        const mod = (await import(/* @vite-ignore */ url)) as PluginModule & {
          default?: PluginModule;
        };
        return mod.default ?? mod;
      },
    });
  }

  const sorted = [...bundled].sort(
    (a, b) => (a.manifest.order ?? 100) - (b.manifest.order ?? 100)
  );
  for (const b of sorted) {
    if (desired.has(b.manifest.id)) continue;
    if (disabled.has(b.manifest.id)) {
      emit("plugin:skipped", { id: b.manifest.id, reason: "disabled" }, "host");
      continue;
    }
    desired.set(b.manifest.id, {
      manifest: b.manifest,
      source: "bundled",
      load: () => b.load(),
    });
  }

  return {
    desired,
    disabled,
    preset: config.active_preset ?? "coder",
    order,
  };
}

function sortDesired(
  desired: Map<string, DesiredPlugin>,
  configOrder: string[]
): DesiredPlugin[] {
  return [...desired.values()].sort((a, b) => {
    const oa = effectiveSortKey(a.manifest.id, a.manifest.order, configOrder);
    const ob = effectiveSortKey(b.manifest.id, b.manifest.order, configOrder);
    if (oa !== ob) return oa - ob;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

/** 只挂载/卸载与配置不一致的插件，其它面板保持不动。 */
export async function reconcilePlugins(bundled: BundledPlugin[]): Promise<void> {
  const { desired, disabled, preset, order } = await collectDesired(bundled);

  for (const id of [...mounted.keys()]) {
    if (!desired.has(id)) {
      await unmountOne(id);
    }
  }

  const sorted = sortDesired(desired, order);
  const toMount = sorted.filter((spec) => !mounted.has(spec.manifest.id));
  for (const spec of sorted) {
    if (!mounted.has(spec.manifest.id)) continue;
    const cssOrder = effectiveSortKey(
      spec.manifest.id,
      spec.manifest.order,
      order
    );
    mounted.get(spec.manifest.id)!.order = cssOrder;
  }

  // 并行拉 chunk，再按 order 挂载 — 缩短首屏左栏+围栏齐活时间
  const loaded = await Promise.all(
    toMount.map(async (spec) => {
      try {
        const mod = await spec.load();
        return { spec, mod, error: null as string | null };
      } catch (e) {
        console.error("plugin load", spec.manifest.id, e);
        emit(
          "plugin:error",
          { id: spec.manifest.id, phase: "import", error: String(e) },
          "host"
        );
        return { spec, mod: null, error: String(e) };
      }
    })
  );

  for (const { spec, mod } of loaded) {
    if (!mod) continue;
    const cssOrder = effectiveSortKey(
      spec.manifest.id,
      spec.manifest.order,
      order
    );
    try {
      await mountOne(spec.manifest, mod, spec.source, spec.cssHref, cssOrder);
    } catch (e) {
      console.error("plugin mount", spec.manifest.id, e);
      emit(
        "plugin:error",
        { id: spec.manifest.id, phase: "mount", error: String(e) },
        "host"
      );
    }
  }

  if (order.length) {
    applyOrderList(order);
  } else {
    publishMountStore();
  }

  emit(
    "plugin:ready",
    {
      mounted: [...mounted.keys()],
      disabled: [...disabled],
      preset,
      order,
    },
    "host"
  );
}

export async function loadAll(bundled: BundledPlugin[]): Promise<void> {
  await reconcilePlugins(bundled);
}

export async function setPluginDisabled(id: string, disabled: boolean): Promise<void> {
  await invoke("plugin_set_disabled", { id, disabled });
}

/** 开关单个插件：只动这一个，不全量刷新。 */
export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  bundled: BundledPlugin[]
): Promise<void> {
  await setPluginDisabled(id, !enabled);
  await reconcilePlugins(bundled);
}

export async function setPluginOrder(order: string[]): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_set_order", { order });
  applyOrderList(cfg.order ?? order);
  emit("plugin:order", { order: cfg.order ?? order }, "host");
  return cfg;
}

/** 同槽内上下移一格，写入 custom order */
export async function movePluginInSlot(id: string, dir: -1 | 1): Promise<PluginsConfig | null> {
  const m = mounted.get(id);
  if (!m || m.manifest.slot === "overlay") return null;
  const siblings = listSlotOrder(m.manifest.slot);
  const i = siblings.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= siblings.length) return null;
  const next = [...siblings];
  [next[i], next[j]] = [next[j], next[i]];
  const left = m.manifest.slot === "left" ? next : listSlotOrder("left");
  const right = m.manifest.slot === "right" ? next : listSlotOrder("right");
  return setPluginOrder([...left, ...right]);
}

/** 显式重载：全部卸载再按配置装回（命令面板「重载插件」用）。 */
export async function reloadPlugins(bundled: BundledPlugin[]): Promise<void> {
  for (const id of [...mounted.keys()]) {
    await unmountOne(id);
  }
  await reconcilePlugins(bundled);
}
