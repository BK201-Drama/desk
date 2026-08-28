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
  bundled: BundledPlugin[],
  name?: string
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_save_custom", {
    name: name?.trim() || null,
  });
  emit("preset:saved-custom", { disabled: cfg.disabled, name: cfg.custom_name }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function discardCustomDraft(
  bundled: BundledPlugin[]
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_discard_custom_draft");
  emit("preset:discarded-draft", { disabled: cfg.disabled }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function getConfig(): Promise<PluginsConfig> {
  return invoke<PluginsConfig>("plugin_get_config");
}
