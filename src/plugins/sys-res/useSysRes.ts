import { useCallback, useEffect, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import { normalizeSnapshot, type SysResSnapshot } from "./model";

const POLL_MS = 2500;
const BOOT_DELAY_MS = 800;

export function useSysRes(ctx: HostContext) {
  const [snap, setSnap] = useState<SysResSnapshot | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const raw = await ctx.invoke("sys_res_snapshot");
      setSnap(normalizeSnapshot(raw));
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

  return { snap, error, refresh };
}
