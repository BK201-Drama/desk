import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import { layoutFromFences, normalizeFences, type FenceGroup } from "./model";

export function useFences(ctx: HostContext) {
  const [fences, setFences] = useState<FenceGroup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFences = useCallback(async () => {
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
  }, [ctx]);

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

  /** 只负责「打开」。记入最近由调用方（FencePanel::doLaunch）决定 ——
      这里是「最近」那条边界的外面，不该知道 recent 的存在。 */
  const launch = useCallback(
    (path: string, id?: string) => {
      if (ctx.editing()) return;
      void ctx
        .invoke("fence_launch", { path })
        .then(() => ctx.emit("fence:launch", { path, id }))
        .catch((err) => console.error(err));
    },
    [ctx]
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
    loadError,
    loadFences: async () => {
      await loadFences();
      await reconcileDesktop();
    },
    persistOrder,
    launch,
  };
}
