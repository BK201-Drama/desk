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

export function schemeName(cfg: PluginsConfig): string {
  const n = cfg.custom_name?.trim();
  return n ? n : "我的方案";
}

export function hasCustomSaved(cfg: PluginsConfig): boolean {
  return cfg.custom_disabled != null;
}

export function hasCustomDraft(cfg: PluginsConfig): boolean {
  if (!hasCustomSaved(cfg)) {
    return cfg.active_preset === "custom";
  }
  const d = cfg.custom_disabled ?? [];
  const o = cfg.custom_order ?? [];
  const curD = cfg.disabled ?? [];
  const curO = cfg.order ?? [];
  return (
    curD.length !== d.length ||
    curO.length !== o.length ||
    curD.some((id, i) => id !== d[i]) ||
    curO.some((id, i) => id !== o[i])
  );
}

const ALL_KNOWN_PLUGINS = [
  "github",
  "multica",
  "remind",
  "fence",
  "qq-music",
  "clock",
  "ops-hud",
  "event-tape",
  "hello",
] as const;

export function idsFromSnapshot(disabled: string[], order: string[]): string[] {
  const dis = new Set(disabled);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (id === "cmdk" || dis.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of ALL_KNOWN_PLUGINS) {
    if (dis.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function savedEnabledIds(cfg: PluginsConfig): string[] {
  if (!hasCustomSaved(cfg)) return [];
  return idsFromSnapshot(cfg.custom_disabled ?? [], cfg.custom_order ?? []);
}