import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import {
  RECENT_LS_KEY,
  RECENT_MAX,
  layoutFromFences,
  normalizeFences,
  type FenceGroup,
} from "./model";
import { asArray } from "../../lib/safe";

export function useFences(ctx: HostContext) {
  const [fences, setFences] = useState<FenceGroup[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      let ids = asArray<string>(await ctx.invoke("recent_list")).slice(0, RECENT_MAX);
      if (!ids.length) {
        try {
          const raw = localStorage.getItem(RECENT_LS_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as unknown;
            const legacy = asArray<unknown>(parsed)
              .filter((x): x is string => typeof x === "string" && !x.startsWith("sys-"))
              .slice(0, RECENT_MAX);
            localStorage.removeItem(RECENT_LS_KEY);
            for (const id of [...legacy].reverse()) {
              ids = asArray<string>(await ctx.invoke("recent_push", { id })).slice(0, RECENT_MAX);
            }
          }
        } catch {
          /* ignore */
        }
      }
      setRecentIds(ids);
    } catch (e) {
      console.warn("recent_list", e);
      setRecentIds([]);
    }
  }, [ctx]);

  const loadFences = useCallback(async () => {
    await loadRecent();
    // 快路径：已有 vault 时先 list，避免开机同步跑完整 takeover（挪图标/抽图标/藏桌面）卡住 UI
    try {
      const raw = await ctx.invoke("fence_list");
      const next = normalizeFences(raw);
      setFences(next);
      setLoadError(null);
      ctx.emit("fence:loaded", {
        count: next.reduce((n, f) => n + f.items.length, 0),
        phase: "list",
      });
    } catch (e) {
      console.warn("fence_list failed", e);
      setLoadError(String(e));
      setFences([]);
    }
  }, [ctx, loadRecent]);

  /** 后台 reconcile：桌面新图标进 vault；不挡首屏 */
  const reconcileDesktop = useCallback(async () => {
    try {
      const raw = await ctx.invoke("fence_takeover");
      const next = normalizeFences(raw);
      setFences(next);
      setLoadError(null);
      ctx.emit("fence:loaded", {
        count: next.reduce((n, f) => n + f.items.length, 0),
        phase: "takeover",
      });
    } catch (e) {
      console.warn("fence_takeover deferred", e);
    }
  }, [ctx]);

  const persistOrder = useCallback(
    async (next: FenceGroup[]) => {
      setFences(next);
      try {
        const raw = await ctx.invoke("fence_save_order", {
          layout: layoutFromFences(next),
        });
        setFences(normalizeFences(raw));
      } catch (e) {
        console.error("fence_save_order", e);
      }
    },
    [ctx]
  );

  const recordRecent = useCallback(
    (id: string) => {
      if (id.startsWith("sys-")) return;
      void ctx
        .invoke("recent_push", { id })
        .then((ids) => setRecentIds(asArray<string>(ids).slice(0, RECENT_MAX)))
        .catch((e) => console.warn("recent_push", e));
    },
    [ctx]
  );

  const launch = useCallback(
    (path: string, id?: string) => {
      if (ctx.editing()) return;
      if (id) recordRecent(id);
      void ctx
        .invoke("fence_launch", { path })
        .then(() => ctx.emit("fence:launch", { path, id }))
        .catch((err) => console.error(err));
    },
    [ctx, recordRecent]
  );

  useEffect(() => {
    let cancelled = false;
    const boot = window.setTimeout(() => {
      if (cancelled) return;
      void loadFences();
    }, 250);
    const takeover = window.setTimeout(() => {
      if (cancelled) return;
      void reconcileDesktop();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(boot);
      window.clearTimeout(takeover);
    };
    // 仅冷启动一次；ctx 稳定，避免依赖抖动反复清 timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    fences,
    setFences,
    recentIds,
    loadError,
    loadFences: async () => {
      await loadFences();
      await reconcileDesktop();
    },
    persistOrder,
    launch,
  };
}
