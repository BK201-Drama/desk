/**
 * 应用启动 — 副作用与 imperative 桥接（逐步迁入 React Context）
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

declare global {
  interface Window {
    __deskHost?: DeskHostBridge;
    __deskOpenCmdk?: () => void;
    __deskFocusFenceSearch?: () => void;
  }
}

export function bootstrapDesk(): void {
  initReorderDrag();

  window.__deskHost = {
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

  void listen("desk:toggle-edit", () => {
    toggleEditing();
  });

  void loadAll(bundledPlugins)
    .then(() => {
      emit("host:boot", { plugins: bundledPlugins.map((p) => p.manifest.id) }, "host");
    })
    .catch((e) => {
      console.error("plugin boot failed", e);
      const left = document.getElementById("slot-left");
      if (left) {
        left.innerHTML = `<div class="plugin-error">插件宿主启动失败：${String(e)}</div>`;
      }
    });
}
