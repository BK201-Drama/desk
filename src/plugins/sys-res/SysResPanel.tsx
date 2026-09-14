import { useEffect, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import {
  buildRingSegments,
  formatRate,
  memPct,
  softSeriesMax,
  smoothSeries,
  sparklineSmooth,
  type RingSegment,
  type SysResSnapshot,
} from "./model";
import { useSysRes, type NetHistory } from "./useSysRes";
import "./panel.css";

const APP_COLORS = ["#2d6a4f", "#52b788", "#95d5b2"];
const REST_COLOR = "rgba(26,35,50,0.14)";
const R = 30;
const C = 2 * Math.PI * R;
const CX = 39;
const CY = 39;

/** 与双环同高的单图 */
const CHART_W = 80;
const CHART_H = 36;

function segmentStroke(seg: RingSegment, appIndex: number): string {
  if (seg.kind === "rest") return REST_COLOR;
  return APP_COLORS[appIndex] ?? APP_COLORS[APP_COLORS.length - 1]!;
}

function formatMemSub(used: number, total: number): string {
  const toG = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return "0";
    const g = n / 1024 ** 3;
    return g >= 10 ? g.toFixed(0) : g.toFixed(1);
  };
  return `${toG(used)}/${toG(total)}G`;
}

function shortAppName(name: string): string {
  const n = name.replace(/\.exe$/i, "").trim();
  const map: Record<string, string> = {
    msedgewebview2: "edge",
    microsoftedgeupdate: "edge-upd",
    cursor: "Cursor",
    code: "Code",
  };
  const key = n.toLowerCase();
  if (map[key]) return map[key]!;
  return n.length > 8 ? `${n.slice(0, 7)}…` : n;
}

type RingViewProps = {
  segments: RingSegment[];
  overviewPct: number;
  overviewSub: string;
  ariaLabel: string;
};

function RingView({
  segments,
  overviewPct,
  overviewSub,
  ariaLabel,
}: RingViewProps) {
  const [active, setActive] = useState<number | null>(null);
  const seg = active != null ? segments[active] : null;

  const pctText = seg
    ? seg.kind === "rest"
      ? `${Math.round(seg.pct)}%`
      : seg.label
    : `${Math.round(overviewPct)}%`;
  const subText = seg
    ? seg.kind === "rest"
      ? "空闲"
      : shortAppName(seg.name)
    : overviewSub;
  const subIsApp = Boolean(seg && seg.kind === "app");

  let offset = 0;
  let appIndex = 0;

  return (
    <div className="sys-res-cell">
      <div
        className="sys-res-ring"
        aria-label={ariaLabel}
        onMouseLeave={() => setActive(null)}
      >
        <svg viewBox="0 0 78 78">
          {segments.map((s, i) => {
            const dash = (s.pct / 100) * C;
            const dashOffset = (-offset * C) / 100;
            offset += s.pct;
            const hot = active === i;
            const dim = active != null && active !== i;
            const color =
              s.kind === "rest" ? REST_COLOR : segmentStroke(s, appIndex++);
            return (
              <circle
                key={`${s.name}-${i}`}
                className={`sys-res-seg${hot ? " is-hot" : ""}${dim ? " is-dim" : ""}`}
                cx={CX}
                cy={CY}
                r={R}
                stroke={color}
                strokeDasharray={`${dash} ${C}`}
                strokeDashoffset={dashOffset}
                onMouseEnter={() => setActive(i)}
                onClick={() => setActive(i)}
              />
            );
          })}
        </svg>
        <div className="sys-res-center">
          <div className="sys-res-pct">{pctText}</div>
          <div className={`sys-res-sub${subIsApp ? " is-app" : ""}`}>{subText}</div>
        </div>
      </div>
    </div>
  );
}

function NetSpark({
  hist,
  downBps,
  upBps,
}: {
  hist: NetHistory;
  downBps: number;
  upBps: number;
}) {
  const down = smoothSeries(hist.down);
  const up = smoothSeries(hist.up);
  const max = softSeriesMax([...down, ...up]);
  const dl = sparklineSmooth(down, CHART_W, CHART_H, 3, max);
  const ul = sparklineSmooth(up, CHART_W, CHART_H, 3, max);

  return (
    <div className="sys-res-net" aria-label="网络">
      <svg
        className="sys-res-chart"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
      >
        <line
          className="sys-res-chart-base"
          x1="0"
          y1={CHART_H - 3}
          x2={CHART_W}
          y2={CHART_H - 3}
        />
        {dl.area ? <path d={dl.area} className="sys-res-chart-fill" /> : null}
        {dl.line ? (
          <path d={dl.line} className="sys-res-chart-dl" fill="none" />
        ) : null}
        {ul.line ? (
          <path d={ul.line} className="sys-res-chart-ul" fill="none" />
        ) : null}
      </svg>
      <div className="sys-res-rates">
        <div className="sys-res-rate is-dl">
          <span className="sys-res-rate-arrow">↓</span>
          {formatRate(downBps)}
        </div>
        <div className="sys-res-rate is-ul">
          <span className="sys-res-rate-arrow">↑</span>
          {formatRate(upBps)}
        </div>
      </div>
    </div>
  );
}

function Board({
  snap,
  netHist,
}: {
  snap: SysResSnapshot;
  netHist: NetHistory;
}) {
  const memSegs = buildRingSegments(snap, "mem", 3);
  const cpuSegs = buildRingSegments(snap, "cpu", 3);
  const memUsedPct = memPct(snap.memUsedBytes, snap.memTotalBytes);

  return (
    <div className="sys-res-row">
      <RingView
        segments={memSegs}
        overviewPct={memUsedPct}
        overviewSub={formatMemSub(snap.memUsedBytes, snap.memTotalBytes)}
        ariaLabel="内存"
      />
      <RingView
        segments={cpuSegs}
        overviewPct={snap.cpuPct}
        overviewSub="CPU"
        ariaLabel="CPU"
      />
      <NetSpark
        hist={netHist}
        downBps={snap.netDownBps}
        upBps={snap.netUpBps}
      />
    </div>
  );
}

export function SysResPanel({ ctx }: PluginComponentProps) {
  const { snap, netHist, error, refresh } = useSysRes(ctx);

  useEffect(() => {
    return ctx.registerCommand({
      id: "refresh",
      title: "刷新系统资源",
      group: "系统",
      run: () => void refresh(),
    });
  }, [ctx, refresh]);

  return (
    <div className="sys-res" data-testid="sys-res-panel">
      {error ? (
        <div className="sys-res-error">无法读取：{error}</div>
      ) : !snap ? (
        <div className="sys-res-empty">采样中…</div>
      ) : (
        <Board snap={snap} netHist={netHist} />
      )}
    </div>
  );
}

export default SysResPanel;
