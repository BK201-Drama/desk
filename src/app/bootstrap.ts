/**
 * 应用启动 — 插件加载与全局监听（桥接对象由 React Provider 持有）
 */
import { listen } from "@tauri-apps/api/event";
import { toggleEditing } from "../host/edit";
import {
  loadAll,
  movePluginInSlot,
  reloadPlugins,
  setPluginEnabled,
} from "../host/registry";
import {
  applyPreset,
  applyScheme,
  createScheme,
  deleteScheme,
  discardSchemeDraft,
  updateScheme,
} from "../host/presets";
import { initReorderDrag } from "../host/reorder";
import { emit } from "../host/events";
import { bundledPlugins } from "../plugins";
import { preloadGithubBoot } from "../plugins/github/boot";

export type DeskHostBridge = {
  reloadPlugins: () => Promise<void>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<void>;
  movePlugin: (id: string, dir: -1 | 1) => Promise<void>;
  applyPreset: (id: string) => Promise<void>;
  applyScheme: (id: string) => Promise<void>;
  createScheme: (name?: string) => Promise<void>;
  updateScheme: (id: string, name?: string) => Promise<void>;
  deleteScheme: (id: string) => Promise<void>;
  discardDraft: () => Promise<void>;
};

export function createDeskHostBridge(): DeskHostBridge {
  return {
    reloadPlugins: () => reloadPlugins(bundledPlugins),
    setPluginEnabled: (id, enabled) => setPluginEnabled(id, enabled, bundledPlugins),
    movePlugin: async (id, dir) => {
      await movePluginInSlot(id, dir);
    },
    applyPreset: async (id) => {
      await applyPreset(id, bundledPlugins);
    },
    applyScheme: async (id) => {
      await applyScheme(id, bundledPlugins);
    },
    createScheme: async (name) => {
      await createScheme(bundledPlugins, name);
    },
    updateScheme: async (id, name) => {
      await updateScheme(bundledPlugins, id, name);
    },
    deleteScheme: async (id) => {
      await deleteScheme(bundledPlugins, id);
    },
    discardDraft: async () => {
      await discardSchemeDraft(bundledPlugins);
    },
  };
}

export function bootstrapDesk(_bridge: DeskHostBridge): void {
  initReorderDrag();

  void listen("desk:toggle-edit", () => {
    toggleEditing();
  });

  // 预读 cache 与挂载并行：不再串行挡住围栏/其它面板首屏
  const t0 = performance.now();
  void Promise.all([preloadGithubBoot().catch(() => undefined), loadAll(bundledPlugins)])
    .then(() => {
      const ms = Math.round(performance.now() - t0);
      emit(
        "host:boot",
        { plugins: bundledPlugins.map((p) => p.manifest.id), ms },
        "host"
      );
      console.info(`[desk] plugins ready in ${ms}ms`);
      return invokeBootMark(ms);
    })
    .catch((e) => {
      console.error("plugin boot failed", e);
      const left = document.getElementById("slot-left");
      if (left) {
        left.innerHTML = `<div class="plugin-error">插件宿主启动失败：${String(e)}</div>`;
      }
    });
}

async function invokeBootMark(ms: number): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("boot_mark", { ms });
  } catch {
    /* optional command / outside tauri */
  }
}
