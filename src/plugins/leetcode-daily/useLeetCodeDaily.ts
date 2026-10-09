import { useCallback, useEffect, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import { normalizeDaily, type LeetCodeDaily } from "./model";

const POLL_MS = 60 * 60 * 1000;

export function useLeetCodeDaily(ctx: HostContext) {
  const [daily, setDaily] = useState<LeetCodeDaily | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      try {
        const cached = normalizeDaily(await ctx.invoke("leetcode_daily_cached"));
        if (cached) setDaily((prev) => prev ?? cached);
      } catch {
        /* cache miss ok */
      }
      const next = normalizeDaily(await ctx.invoke("leetcode_daily"));
      if (!next) throw new Error("空响应");
      setDaily(next);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
    }
  }, [ctx]);

  useEffect(() => {
    const boot = window.setTimeout(() => void refresh(), 800);
    const iv = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(iv);
    };
  }, [refresh]);

  return { daily, error, refresh };
}
