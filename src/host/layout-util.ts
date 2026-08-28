/**
 * 兼容层：领域逻辑在 domain/layout；enabledIds 仍依赖宿主 listMounted。
 */
import { activeScheme, schemeEnabledIds } from "../domain/layout";
import { listMounted } from "./registry";
import type { PluginsConfig } from "./types";

export * from "../domain/layout";

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
