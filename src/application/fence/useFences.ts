import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import {
  RECENT_LS_KEY,
  RECENT_MAX,
  layoutFromFences,
  normalizeFences,
  type FenceGroup,
} from "../../domain/fence";
import { asArray } from "../../domain/shared/safe";

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
    try {
      const raw = await ctx.invoke("fence_takeover");
      const next = normalizeFences(raw);
      setFences(next);
      setLoadError(null);
      ctx.emit("fence:loaded", {
        count: next.reduce((n, f) => n + f.items.length, 0),
      });
    } catch (e) {
      console.warn("fence_takeover failed, try list", e);
      try {
        const raw = await ctx.invoke("fence_list");
        setFences(normalizeFences(raw));
        setLoadError(null);
      } catch (e2) {
        console.error(e2);
        setLoadError(String(e));
        setFences([]);
      }
    }
  }, [ctx, loadRecent]);

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
    void loadFences();
  }, [loadFences]);

  return {
    fences,
    setFences,
    recentIds,
    loadError,
    loadFences,
    persistOrder,
    launch,
  };
}
