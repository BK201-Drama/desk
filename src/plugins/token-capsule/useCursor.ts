import { useCallback, useEffect, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import { emptyUsage, normalizeUsage, type CursorUsage } from "./model";

const POLL_MS = 60_000;

export function useCursorUsage(ctx: HostContext) {
  const [usage, setUsage] = useState<CursorUsage>(emptyUsage());
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const raw = await ctx.invoke("cursor_usage");
      setUsage(normalizeUsage(raw));
    } catch (e) {
      setUsage(emptyUsage(String(e)));
    } finally {
      busy.current = false;
    }
  }, [ctx]);

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(), 1800);
    const iv = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [refresh]);

  return { usage, refresh };
}
