import { useCallback, useEffect, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import { normalizeSnapshot, type SysResSnapshot } from "./model";

const POLL_MS = 2000;
const BOOT_DELAY_MS = 800;
const NET_HISTORY = 28;

export type NetHistory = {
  down: number[];
  up: number[];
};

function pushNet(hist: NetHistory, down: number, up: number): NetHistory {
  const nextDown = [...hist.down, Math.max(0, down)].slice(-NET_HISTORY);
  const nextUp = [...hist.up, Math.max(0, up)].slice(-NET_HISTORY);
  return { down: nextDown, up: nextUp };
}

export function useSysRes(ctx: HostContext) {
  const [snap, setSnap] = useState<SysResSnapshot | null>(null);
  const [netHist, setNetHist] = useState<NetHistory>({ down: [], up: [] });
  const [error, setError] = useState("");
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const raw = await ctx.invoke("sys_res_snapshot");
      const next = normalizeSnapshot(raw);
      setSnap(next);
      setNetHist((h) => pushNet(h, next.netDownBps, next.netUpBps));
      setError("");
      ctx.emit("sys-res:sync", { ok: true });
    } catch (e) {
      setError(String(e));
      ctx.emit("sys-res:sync", { ok: false, error: String(e) });
    } finally {
      busy.current = false;
    }
  }, [ctx]);

  useEffect(() => {
    const boot = window.setTimeout(() => void refresh(), BOOT_DELAY_MS);
    const iv = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(iv);
    };
  }, [refresh]);

  return { snap, netHist, error, refresh };
}
