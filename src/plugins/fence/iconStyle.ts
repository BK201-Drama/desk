import type { CSSProperties } from "react";
import type { HostContext } from "../../host/types";

export function fenceIconStyle(
  ctx: HostContext,
  icon: string | null,
  label: string
): CSSProperties {
  if (icon) {
    try {
      return { backgroundImage: `url('${ctx.convertFileSrc(icon)}')` };
    } catch {
      return { backgroundImage: `url('${icon}')` };
    }
  }
  if (label === "回收站") {
    return { background: "linear-gradient(145deg,#94a3b8,#475569)" };
  }
  if (label === "此电脑") {
    return { background: "linear-gradient(145deg,#93c5fd,#2563eb)" };
  }
  return { background: "linear-gradient(145deg,#c4b5fd,#7c3aed)" };
}

export function highlightLabelParts(
  label: string,
  q: string
): { before: string; mid: string; after: string } | null {
  if (!q) return null;
  const lower = label.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return null;
  return {
    before: label.slice(0, idx),
    mid: label.slice(idx, idx + q.length),
    after: label.slice(idx + q.length),
  };
}
