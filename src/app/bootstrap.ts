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
import { invoke } from "@tauri-apps/api/core";

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

  // Task 13：真桌面在 desk 外面被改动 → 后端重扫完，把新看板推过来。
  // 后端事件只到得了 `@tauri-apps/api`，到不了进程内总线 —— 在这里**桥一次**，
  // 插件继续只用 `ctx.on`（插件不 import @tauri-apps/api，这是它们的分界线）。
  // 将来的 ops 回执、右键菜单也走这一条，见 spec §4.2「单一更新路径」。
  void listen<unknown>("fence:changed", (e) => {
    emit("fence:changed", e.payload, "host");
  });

  // GitHub cache 已在 main.tsx 预读；这里只挂插件
  const t0 = performance.now();
  void loadAll(bundledPlugins)
    .then(() => {
      const ms = Math.round(performance.now() - t0);
      emit(
        "host:boot",
        { plugins: bundledPlugins.map((p) => p.manifest.id), ms },
        "host"
      );
      console.info(`[desk] plugins ready in ${ms}ms`);
      return invoke("boot_mark", { ms }).catch(() => undefined);
    })
    .catch((e) => {
      console.error("plugin boot failed", e);
      const left = document.getElementById("slot-left");
      if (left) {
        left.innerHTML = `<div class="plugin-error">插件宿主启动失败：${String(e)}</div>`;
      }
    });
}
