import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import {
  multicaIssueUrl,
  normalizeMulticaSnapshot,
  type MulticaSnapshot,
} from "./model";
import { setSyncStatus } from "../../host/util";

const PANEL_REFRESH_MS = 5 * 60 * 1000;

export function useMulticaSnapshot(ctx: HostContext) {
  const [snap, setSnap] = useState<MulticaSnapshot | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const at = Date.now();
    try {
      const raw = await ctx.invoke("multica_snapshot");
      const next = normalizeMulticaSnapshot(raw);
      setSnap(next);
      setErrorText(null);
      ctx.emit("multica:sync", {
        ok: true,
        cached: next.cached,
        online: next.runtime_online,
        ms: Date.now() - at,
      });
      return next;
    } catch (e) {
      console.error("multica_snapshot", e);
      setErrorText(String(e));
      ctx.emit("multica:sync", { ok: false, error: String(e) });
      return null;
    }
  }, [ctx]);

  const openBoard = useCallback(async () => {
    try {
      const url = await ctx.invoke<string>("multica_app_url");
      await ctx.openUrl(url || "http://localhost:18473");
    } catch {
      await ctx.openUrl("http://localhost:18473");
    }
  }, [ctx]);

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(), 1500);
    const iv = window.setInterval(() => void refresh(), PANEL_REFRESH_MS);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [refresh]);

  return { snap, errorText, refresh, openBoard };
}

export { multicaIssueUrl, setSyncStatus };
