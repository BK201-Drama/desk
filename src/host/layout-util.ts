import { listMounted } from "./registry";
import type { PluginsConfig } from "./types";

export const PRESET_LABEL: Record<string, string> = {
  coder: "程序员",
  minimal: "极简",
  fence: "仅围栏",
  custom: "自定义",
};

const PLUGIN_SHORT: Record<string, string> = {
  github: "GitHub",
  multica: "Multica",
  remind: "待办",
  fence: "围栏",
  "qq-music": "QQ",
  clock: "时钟",
  "ops-hud": "HUD",
  "event-tape": "磁带",
  hello: "Hello",
  cmdk: "命令",
};

export function chipLabel(id: string): string {
  return PLUGIN_SHORT[id] ?? id;
}

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
