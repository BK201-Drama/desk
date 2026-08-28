import { listen } from "@tauri-apps/api/event";
import { toggleEditing } from "./host/edit";
import {
  loadAll,
  movePluginInSlot,
  reloadPlugins,
  setPluginEnabled,
} from "./host/registry";
import { applyPreset, discardCustomDraft, saveCustomPreset } from "./host/presets";
import { initReorderDrag } from "./host/reorder";
import { emit } from "./host/events";
import { bundledPlugins } from "./plugins";
import "./styles.css";

(window as unknown as {
  __deskHost: {
    reloadPlugins: () => Promise<void>;
    setPluginEnabled: (id: string, enabled: boolean) => Promise<void>;
    movePlugin: (id: string, dir: -1 | 1) => Promise<void>;
    applyPreset: (id: string) => Promise<void>;
    saveCustom: (name?: string) => Promise<void>;
    discardCustom: () => Promise<void>;
  };
}).__deskHost = {
  reloadPlugins: () => reloadPlugins(bundledPlugins),
  setPluginEnabled: (id, enabled) => setPluginEnabled(id, enabled, bundledPlugins),
  movePlugin: async (id, dir) => {
    await movePluginInSlot(id, dir);
  },
  applyPreset: async (id: string) => {
    await applyPreset(id, bundledPlugins);
  },
  saveCustom: async (name?: string) => {
    await saveCustomPreset(bundledPlugins, name);
  },
  discardCustom: async () => {
    await discardCustomDraft(bundledPlugins);
  },
};

window.addEventListener("DOMContentLoaded", () => {
  initReorderDrag();

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
});
