import type { LayoutScheme, PluginsConfig } from "../../host/types";

/** 领域层：布局方案纯逻辑，不依赖 React / Tauri / DOM */

export const MAX_SCHEMES = 3;

export const PRESET_LABEL: Record<string, string> = {
  coder: "程序员",
  minimal: "极简",
  fence: "仅围栏",
  scheme: "自定义方案",
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

export function chipLabel(id: string): string {
  return PLUGIN_SHORT[id] ?? id;
}

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

export function activeScheme(cfg: PluginsConfig): LayoutScheme | null {
  const id = cfg.active_scheme_id;
  if (!id) return null;
  return (cfg.schemes ?? []).find((s) => s.id === id) ?? null;
}

export function schemeEnabledIds(scheme: LayoutScheme): string[] {
  return idsFromSnapshot(scheme.disabled ?? [], scheme.order ?? []);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function hasCustomSaved(cfg: PluginsConfig): boolean {
  return (cfg.schemes?.length ?? 0) > 0;
}

export function hasSchemeDraft(cfg: PluginsConfig): boolean {
  if (cfg.active_preset !== "scheme") return false;
  const scheme = activeScheme(cfg);
  if (!scheme) return true;
  return (
    !sameList(cfg.disabled ?? [], scheme.disabled ?? []) ||
    !sameList(cfg.order ?? [], scheme.order ?? [])
  );
}

export function isBuiltinPreset(preset: string): boolean {
  return preset === "coder" || preset === "minimal" || preset === "fence";
}

export function canCreateScheme(cfg: PluginsConfig): boolean {
  return (cfg.schemes?.length ?? 0) < MAX_SCHEMES;
}
