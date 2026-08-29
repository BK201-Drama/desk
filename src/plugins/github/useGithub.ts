import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import {
  formatContribTip,
  normalizeGithubSnapshot,
  type GithubSnapshot,
} from "./model";
import { formatClockDate, formatClockTime } from "../../lib/time";
import { setSyncStatus } from "../../host/util";

const PANEL_REFRESH_MS = 5 * 60 * 1000;

export function useGithubSnapshot(ctx: HostContext) {
  const [snap, setSnap] = useState<GithubSnapshot | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const at = Date.now();
    try {
      const raw = await ctx.invoke("github_snapshot");
      const next = normalizeGithubSnapshot(raw);
      setSnap(next);
      setErrorText(null);
      ctx.emit("github:sync", {
        ok: true,
        cached: next.cached,
        hasToken: Boolean(next.login),
        ms: Date.now() - at,
      });
      return next;
    } catch (e) {
      console.error("github_snapshot", e);
      setErrorText(String(e));
      ctx.emit("github:sync", { ok: false, error: String(e) });
      return null;
    }
  }, [ctx]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refresh();
    }, 800);
    const iv = window.setInterval(() => void refresh(), PANEL_REFRESH_MS);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [refresh]);

  return { snap, errorText, refresh };
}

export function useLocalClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return {
    time: formatClockTime(now),
    date: formatClockDate(now),
  };
}

export { formatContribTip, setSyncStatus };
