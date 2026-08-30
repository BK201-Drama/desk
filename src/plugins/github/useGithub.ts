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

  const applyRaw = useCallback(
    (raw: unknown, source: "cache" | "live") => {
      const next = normalizeGithubSnapshot(raw);
      if (source === "cache") next.cached = true;
      setSnap(next);
      setErrorText(null);
      return next;
    },
    []
  );

  const loadCache = useCallback(async () => {
    try {
      const raw = await ctx.invoke("github_cached");
      if (raw == null) return null;
      const next = applyRaw(raw, "cache");
      ctx.emit("github:sync", {
        ok: true,
        cached: true,
        hasToken: Boolean(next.login),
        ms: 0,
      });
      return next;
    } catch (e) {
      console.warn("github_cached", e);
      return null;
    }
  }, [ctx, applyRaw]);

  const refresh = useCallback(async () => {
    const at = Date.now();
    try {
      const raw = await ctx.invoke("github_snapshot");
      const next = applyRaw(raw, "live");
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
  }, [ctx, applyRaw]);

  useEffect(() => {
    // 先秒出本地 cache，再后台拉增量；避免首屏空骨架干等 GraphQL
    void loadCache();
    const t = window.setTimeout(() => {
      void refresh();
    }, 900);
    const iv = window.setInterval(() => void refresh(), PANEL_REFRESH_MS);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [loadCache, refresh]);

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
