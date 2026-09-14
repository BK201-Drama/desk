import { asNumber, asObject, asString } from "../../lib/safe";

export type SysResApp = {
  name: string;
  memBytes: number;
  cpuPct: number;
  processCount: number;
};

export type SysResSnapshot = {
  memUsedBytes: number;
  memTotalBytes: number;
  cpuPct: number;
  netDownBps: number;
  netUpBps: number;
  apps: SysResApp[];
  fetchedAt: number;
};

export type SysResSort = "mem" | "cpu";

export type RingSegment = {
  name: string;
  label: string;
  pct: number;
  kind: "app" | "rest";
};

const REST_NAME = "其他/空闲";

export function normalizeApp(raw: unknown): SysResApp | null {
  const o = asObject<Record<string, unknown>>(raw);
  if (!o) return null;
  const name = asString(o.name).trim();
  if (!name) return null;
  return {
    name,
    memBytes: asNumber(o.mem_bytes ?? o.memBytes),
    cpuPct: asNumber(o.cpu_pct ?? o.cpuPct),
    processCount: Math.max(
      1,
      Math.floor(asNumber(o.process_count ?? o.processCount, 1))
    ),
  };
}

export function normalizeSnapshot(raw: unknown): SysResSnapshot {
  const o = asObject<Record<string, unknown>>(raw);
  if (!o) {
    return {
      memUsedBytes: 0,
      memTotalBytes: 0,
      cpuPct: 0,
      netDownBps: 0,
      netUpBps: 0,
      apps: [],
      fetchedAt: 0,
    };
  }
  const appsRaw = Array.isArray(o.apps) ? o.apps : [];
  const apps: SysResApp[] = [];
  for (const row of appsRaw) {
    const a = normalizeApp(row);
    if (a) apps.push(a);
  }
  return {
    memUsedBytes: asNumber(o.mem_used_bytes ?? o.memUsedBytes),
    memTotalBytes: asNumber(o.mem_total_bytes ?? o.memTotalBytes),
    cpuPct: asNumber(o.cpu_pct ?? o.cpuPct),
    netDownBps: asNumber(o.net_down_bps ?? o.netDownBps),
    netUpBps: asNumber(o.net_up_bps ?? o.netUpBps),
    apps,
    fetchedAt: asNumber(o.fetched_at ?? o.fetchedAt),
  };
}

export function topApps(
  apps: SysResApp[],
  sort: SysResSort,
  limit = 5
): SysResApp[] {
  const copy = [...apps];
  copy.sort((a, b) =>
    sort === "mem" ? b.memBytes - a.memBytes : b.cpuPct - a.cpuPct
  );
  return copy.slice(0, limit);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 10 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatCpuPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(Math.max(0, n))}%`;
}

/** 网络速率：B/s → 紧凑字符串（如 1.2M、80K、120） */
export function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return "0";
  if (bps < 1000) return `${Math.round(bps)}`;
  if (bps < 1_000_000) {
    const k = bps / 1000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  const m = bps / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/** 抑制单点尖刺：用偏高分位做纵轴，尖峰仍画出但不会压扁整段历史 */
export function softSeriesMax(series: number[]): number {
  if (series.length === 0) return 1;
  const sorted = [...series]
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 1;
  const peak = sorted[sorted.length - 1]!;
  if (peak <= 0) return 1;
  // 避开最后一个尖峰点再取分位
  const rank = Math.max(
    0,
    Math.min(sorted.length - 2, Math.floor((sorted.length - 1) * 0.85))
  );
  const high = sorted[rank] ?? peak;
  return Math.max(high * 1.35, peak * 0.45, 1);
}

/** 展示用轻平滑，减轻锯齿/毛刺（不改真实读数） */
export function smoothSeries(series: number[], alpha = 0.35): number[] {
  if (series.length === 0) return [];
  const out: number[] = [];
  let prev = series[0]!;
  for (const v of series) {
    const n = Number.isFinite(v) ? Math.max(0, v) : 0;
    prev = prev * (1 - alpha) + n * alpha;
    out.push(prev);
  }
  return out;
}

type Pt = { x: number; y: number };

function sparkPoints(
  series: number[],
  width: number,
  height: number,
  padY: number,
  sharedMax?: number
): Pt[] {
  if (series.length === 0) return [];
  const max = Math.max(1, sharedMax ?? softSeriesMax(series));
  const usable = Math.max(1, height - padY * 2);
  const n = series.length;
  const step = n <= 1 ? 0 : width / (n - 1);
  return series.map((v, i) => {
    const clipped = Math.min(Math.max(0, v), max);
    return {
      x: n <= 1 ? width / 2 : i * step,
      y: height - padY - (clipped / max) * usable,
    };
  });
}

/** 中点二次平滑：比折线柔和，适合迷你 spark */
function smoothLine(pts: Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  if (pts.length === 2) {
    return `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)} L${pts[1]!.x.toFixed(1)},${pts[1]!.y.toFixed(1)}`;
  }
  let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const n = pts[i + 1]!;
    const mx = (p.x + n.x) / 2;
    const my = (p.y + n.y) / 2;
    d += ` Q${p.x.toFixed(1)},${p.y.toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` T${last.x.toFixed(1)},${last.y.toFixed(1)}`;
  return d;
}

/** 折线 path（兼容旧调用）；新 UI 用 sparklineSmooth */
export function sparklinePath(
  series: number[],
  width: number,
  height: number,
  padY = 2,
  sharedMax?: number
): string {
  const pts = sparkPoints(series, width, height, padY, sharedMax);
  if (pts.length === 0) return "";
  return pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}

export function sparklineSmooth(
  series: number[],
  width: number,
  height: number,
  padY = 2,
  sharedMax?: number
): { line: string; area: string } {
  const pts = sparkPoints(series, width, height, padY, sharedMax);
  if (pts.length === 0) return { line: "", area: "" };
  const line = smoothLine(pts);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const base = height - padY;
  const area = `${line} L${last.x.toFixed(1)},${base.toFixed(1)} L${first.x.toFixed(1)},${base.toFixed(1)} Z`;
  return { line, area };
}

/** SVG circle circumference helper: r=16 → C≈100.53 */
export function ringOffset(pct: number, circumference: number): number {
  const p = Math.min(100, Math.max(0, pct)) / 100;
  return circumference * (1 - p);
}

export function memPct(used: number, total: number): number {
  if (!total || total <= 0) return 0;
  return (used / total) * 100;
}

function memSharePct(app: SysResApp, totalBytes: number): number {
  if (!totalBytes || totalBytes <= 0) return 0;
  return (app.memBytes / totalBytes) * 100;
}

/**
 * CPU 环：绿弧总长 = 整机占用 global；段内按进程权重瓜分。
 * 灰段 = 空闲 (100 - global)。避免「进程单核%累加」把环涂满。
 */
function cpuRingShares(
  top: SysResApp[],
  globalCpu: number
): { appPcts: number[]; restPct: number } {
  const global = Math.min(100, Math.max(0, globalCpu));
  const restPct = Math.max(0, 100 - global);
  const weights = top.map((a) => Math.max(0, a.cpuPct));
  const wSum = weights.reduce((s, w) => s + w, 0);
  if (global <= 0 || wSum <= 0) {
    return { appPcts: top.map(() => 0), restPct: 100 };
  }
  return {
    appPcts: weights.map((w) => (w / wSum) * global),
    restPct,
  };
}

/** Top `limit` apps by mem or cpu, plus a rest segment filling to 100. */
export function buildRingSegments(
  snap: SysResSnapshot,
  mode: "mem" | "cpu",
  limit = 3
): RingSegment[] {
  const top = topApps(snap.apps, mode, limit);
  const segments: RingSegment[] = [];

  if (mode === "mem") {
    for (const app of top) {
      segments.push({
        name: app.name,
        label: formatBytes(app.memBytes),
        pct: memSharePct(app, snap.memTotalBytes),
        kind: "app",
      });
    }
    const used = segments.reduce((s, seg) => s + seg.pct, 0);
    const restPct = Math.max(0, 100 - used);
    segments.push({
      name: REST_NAME,
      label: formatBytes(Math.round((snap.memTotalBytes * restPct) / 100)),
      pct: restPct,
      kind: "rest",
    });
    return segments;
  }

  const { appPcts, restPct } = cpuRingShares(top, snap.cpuPct);
  top.forEach((app, i) => {
    const pct = appPcts[i] ?? 0;
    segments.push({
      name: app.name,
      label: formatCpuPct(pct),
      pct,
      kind: "app",
    });
  });
  segments.push({
    name: REST_NAME,
    label: formatCpuPct(restPct),
    pct: restPct,
    kind: "rest",
  });
  return segments;
}
