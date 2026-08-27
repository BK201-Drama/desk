import { listen } from "@tauri-apps/api/event";
import { toggleEditing } from "./host/edit";
import { loadAll, reloadPlugins, setPluginEnabled } from "./host/registry";
import { applyPreset, saveCustomPreset } from "./host/presets";
import { emit } from "./host/events";
import { bundledPlugins } from "./plugins";
import "./styles.css";

(window as unknown as {
  __deskHost: {
    reloadPlugins: () => Promise<void>;
    setPluginEnabled: (id: string, enabled: boolean) => Promise<void>;
    applyPreset: (id: string) => Promise<void>;
    saveCustom: () => Promise<void>;
  };
}).__deskHost = {
  reloadPlugins: () => reloadPlugins(bundledPlugins),
  setPluginEnabled: (id, enabled) => setPluginEnabled(id, enabled, bundledPlugins),
  applyPreset: async (id: string) => {
    await applyPreset(id, bundledPlugins);
  },
  saveCustom: async () => {
    await saveCustomPreset(bundledPlugins);
  },
};

window.addEventListener("DOMContentLoaded", () => {
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
