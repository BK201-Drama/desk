import { invoke } from "@tauri-apps/api/core";
import type { PluginsConfig, PresetInfo } from "./types";
import type { BundledPlugin } from "./types";
import { reconcilePlugins } from "./registry";
import { emit } from "./events";

export async function listPresets(): Promise<PresetInfo[]> {
  return invoke<PresetInfo[]>("plugin_list_presets");
}

export async function applyPreset(
  id: string,
  bundled: BundledPlugin[]
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_apply_preset", { id });
  emit("preset:applied", { id, disabled: cfg.disabled }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function saveCustomPreset(
  bundled: BundledPlugin[]
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_save_custom");
  emit("preset:saved-custom", { disabled: cfg.disabled }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function getConfig(): Promise<PluginsConfig> {
  return invoke<PluginsConfig>("plugin_get_config");
}
