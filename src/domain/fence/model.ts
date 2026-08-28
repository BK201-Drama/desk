import { asArray, asObject, asString } from "../shared/safe";

export type FenceItem = {
  id: string;
  label: string;
  path: string;
  icon: string | null;
};

export type FenceGroup = {
  name: string;
  items: FenceItem[];
};

export type FenceLayout = {
  name: string;
  ids: string[];
};

export const RECENT_MAX = 4;
export const RECENT_LS_KEY = "desk-recent-v1";
export const DRAG_THRESHOLD_PX = 6;

export const SEARCH_ALIASES: Record<string, string[]> = {
  英雄联盟: ["lol", "yxlm", "联盟", "league"],
  "counter-strike 2": ["cs", "cs2", "反恐"],
  穿越火线: ["cf"],
  饥荒联机版: ["饥荒", "dst"],
  terraria: ["泰拉"],
  飞书: ["feishu", "lark"],
  文献批量阅读助手: ["文献", "paper"],
  此电脑: ["pc", "mycomputer", "计算机"],
  回收站: ["recycle", "trash", "垃圾箱"],
};

export function normalizeFenceItem(raw: unknown): FenceItem | null {
  const o = asObject<Record<string, unknown>>(raw);
  if (!o) return null;
  const id = asString(o.id);
  if (!id) return null;
  return {
    id,
    label: asString(o.label),
    path: asString(o.path),
    icon: o.icon == null ? null : asString(o.icon),
  };
}

export function normalizeFences(raw: unknown): FenceGroup[] {
  return asArray<unknown>(raw)
    .map((f) => {
      const o = asObject<Record<string, unknown>>(f);
      if (!o) return null;
      const name = asString(o.name);
      if (!name) return null;
      return {
        name,
        items: asArray<unknown>(o.items)
          .map(normalizeFenceItem)
          .filter((x): x is FenceItem => x != null),
      };
    })
    .filter((x): x is FenceGroup => x != null);
}

export function findItemById(fences: FenceGroup[], id: string): FenceItem | null {
  for (const f of fences) {
    const item = f.items.find((i) => i.id === id);
    if (item) return item;
  }
  return null;
}

export function matchesFenceSearch(item: FenceItem, q: string): boolean {
  const label = item.label.toLowerCase();
  if (label.includes(q)) return true;
  const base = item.path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base.includes(q)) return true;
  const aliases = SEARCH_ALIASES[item.label] ?? SEARCH_ALIASES[label] ?? [];
  if (aliases.some((a) => a.includes(q) || q.includes(a))) return true;
  for (const tokens of Object.values(SEARCH_ALIASES)) {
    if (tokens.includes(q) && tokens.some((t) => label.includes(t))) return true;
  }
  return false;
}

export type FenceSearchHit = { item: FenceItem; fence: string };

export function searchFences(fences: FenceGroup[], query: string): FenceSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: FenceSearchHit[] = [];
  for (const f of fences) {
    for (const item of f.items) {
      if (matchesFenceSearch(item, q)) hits.push({ item, fence: f.name });
    }
  }
  return hits;
}

export function totalFenceItems(fences: FenceGroup[]): number {
  return fences.reduce((n, f) => n + f.items.length, 0);
}

export function recentItems(fences: FenceGroup[], recentIds: string[]): FenceItem[] {
  return recentIds
    .slice(0, RECENT_MAX)
    .map((id) => findItemById(fences, id))
    .filter((item): item is FenceItem => item !== null && !item.id.startsWith("sys-"));
}

export function applyLayout(fences: FenceGroup[], layout: FenceLayout[]): FenceGroup[] {
  if (!layout.length) return fences;
  const byId = new Map<string, FenceItem>();
  for (const f of fences) {
    for (const item of f.items) byId.set(item.id, item);
  }
  return fences.map((f) => {
    const row = layout.find((l) => l.name === f.name);
    if (!row) return f;
    const items = row.ids
      .map((id) => byId.get(id))
      .filter((x): x is FenceItem => !!x && !x.id.startsWith("sys-"));
    const sys = f.items.filter((i) => i.id.startsWith("sys-"));
    const seen = new Set(items.map((i) => i.id));
    for (const i of f.items) {
      if (!i.id.startsWith("sys-") && !seen.has(i.id)) items.push(i);
    }
    return { name: f.name, items: [...items, ...sys] };
  });
}

export function layoutFromFences(fences: FenceGroup[]): FenceLayout[] {
  return fences
    .filter((f) => f.name && f.name !== "系统")
    .map((f) => ({
      name: f.name,
      ids: f.items.map((i) => i.id).filter((id) => id && !id.startsWith("sys-")),
    }));
}

export function moveItemAcross(
  fences: FenceGroup[],
  itemId: string,
  toFenceName: string,
  beforeId: string | null
): FenceGroup[] {
  let moved: FenceItem | null = null;
  const stripped = fences.map((f) => {
    const items = f.items.filter((i) => {
      if (i.id === itemId) {
        moved = i;
        return false;
      }
      return true;
    });
    return { ...f, items };
  });
  if (!moved) return fences;
  return stripped.map((f) => {
    if (f.name !== toFenceName) return f;
    const items = [...f.items];
    if (!beforeId) {
      items.push(moved!);
    } else {
      const idx = items.findIndex((i) => i.id === beforeId);
      if (idx < 0) items.push(moved!);
      else items.splice(idx, 0, moved!);
    }
    return { ...f, items };
  });
}
