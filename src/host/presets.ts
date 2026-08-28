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

export async function applyScheme(
  id: string,
  bundled: BundledPlugin[]
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_apply_scheme", { id });
  emit("preset:applied", { id: `scheme:${id}`, disabled: cfg.disabled }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function createScheme(
  bundled: BundledPlugin[],
  name?: string
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_create_scheme", {
    name: name?.trim() || null,
  });
  emit("scheme:created", { schemes: cfg.schemes }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function updateScheme(
  bundled: BundledPlugin[],
  id: string,
  name?: string
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_update_scheme", {
    id,
    name: name?.trim() || null,
  });
  emit("scheme:updated", { id, name: cfg.schemes?.find((s) => s.id === id)?.name }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function deleteScheme(
  bundled: BundledPlugin[],
  id: string
): Promise<PluginsConfig> {
  const cfg = await invoke<PluginsConfig>("plugin_delete_scheme", { id });
  emit("scheme:deleted", { id }, "host");
  await reconcilePlugins(bundled);
  return cfg;
}

export async function discardSchemeDraft(
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
