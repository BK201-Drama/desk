import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import {
  formatContribTip,
  normalizeGithubSnapshot,
  type GithubSnapshot,
} from "./model";
import { formatClockDate, formatClockTime } from "../../lib/time";
import { setSyncStatus } from "../../host/util";
import { peekGithubBoot, onGithubBoot } from "./boot";

const PANEL_REFRESH_MS = 5 * 60 * 1000;

export function useGithubSnapshot(ctx: HostContext) {
  // 首帧用启动预读；若预读仍在飞，监听完成后补上（与 loadAll 并行）
  const [snap, setSnap] = useState<GithubSnapshot | null>(() => peekGithubBoot());
  const [errorText, setErrorText] = useState<string | null>(null);

  const applyRaw = useCallback((raw: unknown, source: "cache" | "live") => {
    const next = normalizeGithubSnapshot(raw);
    if (source === "cache") next.cached = true;
    setSnap(next);
    setErrorText(null);
    return next;
  }, []);

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
    const unsub = onGithubBoot(() => {
      const boot = peekGithubBoot();
      if (boot) setSnap((prev) => prev ?? boot);
    });
    const boot = peekGithubBoot();
    if (boot) setSnap((prev) => prev ?? boot);

    const t = window.setTimeout(() => {
      void refresh();
    }, 900);
    const iv = window.setInterval(() => void refresh(), PANEL_REFRESH_MS);
    return () => {
      unsub();
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
