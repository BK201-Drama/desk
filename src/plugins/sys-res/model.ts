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

/** 折线 path：series 归一化到 viewBox h，y=0 在底部 */
export function sparklinePath(
  series: number[],
  width: number,
  height: number,
  padY = 2
): string {
  if (series.length === 0) return "";
  const max = Math.max(...series, 1);
  const usable = Math.max(1, height - padY * 2);
  const n = series.length;
  const step = n <= 1 ? 0 : width / (n - 1);
  return series
    .map((v, i) => {
      const x = n <= 1 ? width / 2 : i * step;
      const y = height - padY - (Math.max(0, v) / max) * usable;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
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
