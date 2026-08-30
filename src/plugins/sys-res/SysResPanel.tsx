import { useEffect, useState } from "react";
import type { PluginComponentProps } from "../../host/types";
import {
  buildRingSegments,
  memPct,
  type RingSegment,
  type SysResSnapshot,
} from "./model";
import { useSysRes } from "./useSysRes";
import "./panel.css";

const SEG_COLORS = ["#2d6a4f", "#52b788", "#95d5b2", "rgba(26,35,50,0.14)"];
const R = 30;
const C = 2 * Math.PI * R;
const CX = 39;
const CY = 39;

function formatMemSub(used: number, total: number): string {
  const toG = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return "0";
    const g = n / 1024 ** 3;
    return g >= 10 ? g.toFixed(0) : g.toFixed(1);
  };
  return `${toG(used)}/${toG(total)}G`;
}

type RingViewProps = {
  segments: RingSegment[];
  overviewPct: number;
  overviewSub: string;
  ariaLabel: string;
  cap: string;
};

function RingView({
  segments,
  overviewPct,
  overviewSub,
  ariaLabel,
  cap,
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
      ? "其余"
      : seg.name
    : overviewSub;
  const subIsApp = Boolean(seg && seg.kind === "app");

  let offset = 0;

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
            return (
              <circle
                key={`${s.name}-${i}`}
                className={`sys-res-seg${hot ? " is-hot" : ""}${dim ? " is-dim" : ""}`}
                cx={CX}
                cy={CY}
                r={R}
                stroke={SEG_COLORS[i] ?? SEG_COLORS[SEG_COLORS.length - 1]}
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
      <div className="sys-res-cap">{cap}</div>
    </div>
  );
}

function Rings({ snap }: { snap: SysResSnapshot }) {
  const memSegs = buildRingSegments(snap, "mem", 3);
  const cpuSegs = buildRingSegments(snap, "cpu", 3);
  const memUsedPct = memPct(snap.memUsedBytes, snap.memTotalBytes);

  return (
    <div className="sys-res-row">
      <RingView
        segments={memSegs}
        overviewPct={memUsedPct}
        overviewSub={formatMemSub(snap.memUsedBytes, snap.memTotalBytes)}
        ariaLabel="内存占比"
        cap="内存"
      />
      <RingView
        segments={cpuSegs}
        overviewPct={snap.cpuPct}
        overviewSub="整机"
        ariaLabel="CPU 占比"
        cap="CPU"
      />
    </div>
  );
}

export function SysResPanel({ ctx }: PluginComponentProps) {
  const { snap, error, refresh } = useSysRes(ctx);

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
        <Rings snap={snap} />
      )}
    </div>
  );
}

export default SysResPanel;
