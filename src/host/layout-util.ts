/**
 * 布局辅助：方案纯逻辑在 schemeLogic；enabledIds 依赖已挂载插件。
 */
import { activeScheme, schemeEnabledIds } from "./schemeLogic";
import { listMounted } from "./registry";
import type { PluginsConfig } from "./types";

export * from "./schemeLogic";

export function enabledIds(cfg: PluginsConfig): string[] {
  const disabled = new Set(cfg.disabled ?? []);
  const order = cfg.order ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (id === "cmdk" || disabled.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const m of listMounted()) {
    const id = m.manifest.id;
    if (id === "cmdk" || disabled.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function savedEnabledIds(cfg: PluginsConfig): string[] {
  const scheme = activeScheme(cfg);
  return scheme ? schemeEnabledIds(scheme) : [];
}
