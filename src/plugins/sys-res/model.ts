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

function cpuSharePcts(apps: SysResApp[], top: SysResApp[]): number[] {
  const raw = top.map((a) => Math.max(0, a.cpuPct));
  const sumAll = apps.reduce((s, a) => s + Math.max(0, a.cpuPct), 0);
  if (sumAll <= 100) return raw;
  const scale = 100 / sumAll;
  return raw.map((p) => p * scale);
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

  const pcts = cpuSharePcts(snap.apps, top);
  top.forEach((app, i) => {
    const pct = pcts[i] ?? 0;
    segments.push({
      name: app.name,
      label: formatCpuPct(pct),
      pct,
      kind: "app",
    });
  });
  const used = segments.reduce((s, seg) => s + seg.pct, 0);
  const restPct = Math.max(0, 100 - used);
  segments.push({
    name: REST_NAME,
    label: formatCpuPct(restPct),
    pct: restPct,
    kind: "rest",
  });
  return segments;
}
