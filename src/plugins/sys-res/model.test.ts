import { describe, expect, it } from "vitest";
import {
  buildRingSegments,
  formatBytes,
  formatCpuPct,
  memPct,
  normalizeSnapshot,
  ringOffset,
  topApps,
} from "./model";
import type { SysResSnapshot } from "./model";

describe("normalizeSnapshot", () => {
  it("maps snake_case apps", () => {
    const s = normalizeSnapshot({
      mem_used_bytes: 8_000_000_000,
      mem_total_bytes: 16_000_000_000,
      cpu_pct: 33.3,
      apps: [
        { name: "chrome", mem_bytes: 1e9, cpu_pct: 10, process_count: 3 },
        { name: "code", mem_bytes: 2e9, cpu_pct: 5, process_count: 1 },
      ],
      fetched_at: 1,
    });
    expect(s.memUsedBytes).toBe(8_000_000_000);
    expect(s.apps).toHaveLength(2);
    expect(s.apps[0].processCount).toBe(3);
  });

  it("returns empty on garbage", () => {
    expect(normalizeSnapshot(null).apps).toEqual([]);
  });
});

describe("topApps", () => {
  const apps = [
    { name: "a", memBytes: 100, cpuPct: 1, processCount: 1 },
    { name: "b", memBytes: 50, cpuPct: 9, processCount: 1 },
    { name: "c", memBytes: 200, cpuPct: 2, processCount: 2 },
  ];

  it("sorts by mem and caps at 5", () => {
    expect(topApps(apps, "mem", 2).map((x) => x.name)).toEqual(["c", "a"]);
  });

  it("sorts by cpu", () => {
    expect(topApps(apps, "cpu", 2).map((x) => x.name)).toEqual(["b", "c"]);
  });
});

describe("format", () => {
  it("bytes and cpu", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_500_000_000)).toMatch(/GB/);
    expect(formatCpuPct(12.34)).toBe("12%");
  });
});

describe("memPct", () => {
  it("returns share of total", () => {
    expect(memPct(8e9, 16e9)).toBe(50);
    expect(memPct(0, 0)).toBe(0);
  });
});

describe("ringOffset", () => {
  it("maps pct to dash offset", () => {
    expect(ringOffset(0, 100)).toBe(100);
    expect(ringOffset(100, 100)).toBe(0);
    expect(ringOffset(50, 100)).toBe(50);
  });
});

describe("buildRingSegments", () => {
  const snap: SysResSnapshot = {
    memUsedBytes: 8_000_000_000,
    memTotalBytes: 16_000_000_000,
    cpuPct: 33,
    fetchedAt: 1,
    apps: [
      { name: "chrome", memBytes: 3_200_000_000, cpuPct: 12, processCount: 3 },
      { name: "Cursor", memBytes: 2_400_000_000, cpuPct: 9, processCount: 1 },
      { name: "desk", memBytes: 1_280_000_000, cpuPct: 2, processCount: 1 },
      { name: "other", memBytes: 500_000_000, cpuPct: 1, processCount: 1 },
    ],
  };

  it("mem mode: top 3 by mem share of total + rest", () => {
    const segs = buildRingSegments(snap, "mem", 3);
    expect(segs).toHaveLength(4);
    expect(segs.slice(0, 3).map((s) => s.name)).toEqual([
      "chrome",
      "Cursor",
      "desk",
    ]);
    expect(segs[0].kind).toBe("app");
    expect(segs[0].pct).toBeCloseTo(20, 1);
    expect(segs[3].kind).toBe("rest");
    const sum = segs.reduce((a, s) => a + s.pct, 0);
    expect(sum).toBeCloseTo(100, 5);
  });

  it("cpu mode: top 3 by cpu + rest to 100", () => {
    const segs = buildRingSegments(snap, "cpu", 3);
    expect(segs).toHaveLength(4);
    expect(segs[0].name).toBe("chrome");
    expect(segs[0].pct).toBe(12);
    expect(segs[1].pct).toBe(9);
    expect(segs[2].pct).toBe(2);
    expect(segs[3].kind).toBe("rest");
    expect(segs[3].pct).toBe(77);
    expect(segs[0].label).toBe("12%");
  });

  it("cpu mode: scales when all app cpu sums over 100", () => {
    const hot: SysResSnapshot = {
      ...snap,
      apps: [
        { name: "a", memBytes: 1, cpuPct: 50, processCount: 1 },
        { name: "b", memBytes: 1, cpuPct: 40, processCount: 1 },
        { name: "c", memBytes: 1, cpuPct: 30, processCount: 1 },
        { name: "d", memBytes: 1, cpuPct: 20, processCount: 1 },
      ],
    };
    const segs = buildRingSegments(hot, "cpu", 3);
    const appSum = segs
      .filter((s) => s.kind === "app")
      .reduce((a, s) => a + s.pct, 0);
    expect(appSum).toBeLessThanOrEqual(100);
    expect(segs.find((s) => s.kind === "rest")!.pct).toBeGreaterThanOrEqual(0);
    const total = segs.reduce((a, s) => a + s.pct, 0);
    expect(total).toBeCloseTo(100, 5);
    for (const seg of segs.filter((s) => s.kind === "app")) {
      expect(seg.label).toBe(formatCpuPct(seg.pct));
    }
    expect(segs[0].label).not.toBe("50%");
  });

  it("defaults limit to 3", () => {
    expect(buildRingSegments(snap, "mem")).toHaveLength(4);
  });

  it("mem app labels use formatBytes", () => {
    const segs = buildRingSegments(snap, "mem", 1);
    expect(segs[0].label).toMatch(/GB/);
  });
});
