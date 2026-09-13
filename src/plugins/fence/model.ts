import { asArray, asNumber, asObject, asString } from "../../lib/safe";

export type FenceItem = {
  id: string;
  label: string;
  path: string;
  icon: string | null;
  /** 是不是目录。后端算好的（`index.rs` 的 `is_dir`）——
      前端**不能**自己猜：`label` 里文件的扩展名已经被后端去掉了，
      而目录名带点是常事，`path` 后缀和 `label` 两条猜法都会错。
      必填（不是可选）：生产端只有 `normalizeFenceItem` 一个构造点，
      可选会让 `undefined` 悄悄流进右键菜单的判定。 */
  isDir: boolean;
};

export type FenceGroup = {
  name: string;
  items: FenceItem[];
  /** 收起了（只留标题条）。必填，理由同 `FenceItem.isDir` ——
      它被 `applyLayout` / `moveItemAcross` 两个「重建 group」的地方路过，
      可选的话 `{...f}` 之外的那些重建点会**静默丢掉它**。 */
  collapsed: boolean;
  /** 自定义行数。**0 = 自动**（用 `panel.css` 里 `.fence-grid` 那份默认）。上界 `ROWS_MAX`。 */
  rows: number;
};

export type FenceLayout = {
  name: string;
  ids: string[];
};

/** 拖拽的启动阈值，单位是**屏幕像素**（与 `clientX` 同一坐标系，见
    `FenceContextMenu.tsx` 的文件头）—— 缩放 1.6384 下约等于 3.7 个 CSS 像素，
    比 Windows 自己的 `SM_CXDRAG`（4）还宽一点。

    ⚠️ 2026-09-13 之前它是「编辑态专用」的：那时点与拖分在两个模式里，
    阈值偏小没人会撞上。现在拖拽**常开**（用户需求 1），阈值就变成了
    「点一下图标会不会误判成拖」的唯一防线 —— 所以**不许下调**。 */
export const DRAG_THRESHOLD_PX = 6;

/** 自定义高度的行数范围。与 `index.rs` 的 `ROWS_MAX`、`panel.css` 的 `.rows-N` 三者一致，
    由 `index.rs` 的 `rows_max_matches_frontend` 钉住 —— 改一处就得三处一起改。
    对不上的症状：设了 N 行却画成默认的 2 行（`.fence-grid.rows-N` 这个类不存在）。 */
export const ROWS_MAX = 5;

/** 行数收敛：0 与「非法值」都算自动。后端读取时也夹了一道（`index::ui_of`）。 */
export function clampRows(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
  return n <= 0 ? 0 : Math.min(n, ROWS_MAX);
}

/**
 * `.fence-grid` 的类名。行数用**类**表达，不用内联 `--fence-rows`，因为
 * `overflow-y` 必须跟着行数一起改（1 行的那三栏是 `hidden`，行数调大就会被裁掉
 * 而不是滚动），类能把两条声明写进同一个选择器里 —— 完整理由见 `panel.css`。
 *
 * 自动时**原样返回 `"fence-grid"`**，不拼一个空串：样式审查把 `className`
 * 原文一起录进基线，多个尾随空格就是一处 diff（虽然不影响观感，但会淹掉真信号）。
 */
export function gridClass(rows: number): string {
  const r = clampRows(rows);
  return r > 0 ? `fence-grid rows-${r}` : "fence-grid";
}

/**
 * 系统围栏那两项的 id 前缀（`sys-recycle` / `sys-pc`，见后端 `system_shell_items`）。
 *
 * 它是**跨模块的约定**（右键菜单靠它区分「系统项」与普通项），所以收成一个常量
 * 而不是三处各写一遍字面量 —— 一旦这里和后端不一致，症状是「回收站的菜单里
 * 出现了删除」，而那种 bug 读代码是读不出来的。
 */
export const SYS_ID_PREFIX = "sys-";

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
    // 线上是 snake_case：`FenceItemDto` 没有 `#[serde(rename_all)]`（mod.rs:29）。
    // 只认字面 `true` —— 缺字段 / 写成字符串都算「不是目录」，与后端默认一致。
    isDir: o.is_dir === true,
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
        // 与 `is_dir` 同一条规矩：只认字面 `true`，缺字段 / 写成字符串都算「没收起」。
        collapsed: o.collapsed === true,
        // `asNumber` 已经把非数字挡成 0（= 自动）；`clampRows` 再把越界夹回来。
        // 旧的后端（不认识这两个字段）也能被这套默认值兜住。
        rows: clampRows(asNumber(o.rows)),
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
    const sys = f.items.filter((i) => i.id.startsWith(SYS_ID_PREFIX));
    const seen = new Set(items.map((i) => i.id));
    for (const i of f.items) {
      if (!i.id.startsWith(SYS_ID_PREFIX) && !seen.has(i.id)) items.push(i);
    }
    // `collapsed` / `rows` 是**显示偏好**，与「按 layout 重排」这件事无关 ——
    // 必须原样带过去。漏掉它们的症状是：保存过一次顺序之后，收起的围栏自己展开了。
    return { name: f.name, items: [...items, ...sys], collapsed: f.collapsed, rows: f.rows };
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
