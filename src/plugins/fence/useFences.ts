import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import { layoutFromFences, normalizeFences, type FenceGroup } from "./model";

export function useFences(ctx: HostContext) {
  const [fences, setFences] = useState<FenceGroup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFences = useCallback(
    async (cmd: "fence_list" | "fence_rescan" = "fence_list") => {
      // 冷启动走 `fence_list`：它只读索引 + 把抽图标丢后台，不挡首屏。
      // `fence_rescan` 是「用户刚做完一件事，等着看新结果」时才用 —— 图标同步补。
      try {
        const raw = await ctx.invoke(cmd);
        const next = normalizeFences(raw);
        setFences(next);
        setLoadError(null);
        ctx.emit("fence:loaded", {
          count: next.reduce((n, f) => n + f.items.length, 0),
          phase: cmd === "fence_list" ? "list" : "rescan",
        });
      } catch (e) {
        console.warn(`${cmd} failed`, e);
        setLoadError(String(e));
        setFences([]);
      }
    },
    [ctx]
  );

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
    return () => {
      cancelled = true;
      window.clearTimeout(boot);
    };
    // 仅冷启动一次；ctx 稳定，避免依赖抖动反复清 timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 真桌面变了（在资源管理器里新建 / 删除 / 改名）→ 后端已经重扫完，把新看板推来。
  // 这里**直接采用**，不再 invoke 一次：后端那一拍就是最新的，
  // 再问一遍只会多一趟 IPC，还可能拿回比它更旧的一帧。
  // 桥在 `bootstrap.ts`（后端事件 → 进程内总线），插件这一侧只看 `ctx.on`。
  useEffect(() => {
    return ctx.on("fence:changed", (ev) => {
      const next = normalizeFences(ev.detail);
      setFences(next);
      setLoadError(null);
      ctx.emit("fence:loaded", {
        count: next.reduce((n, f) => n + f.items.length, 0),
        phase: "watch",
      });
    });
  }, [ctx]);

  return {
    fences,
    setFences,
    loadError,
    /** 给「用户主动做完一件事之后」用的重扫：强制重扫 + 同步补图标。 */
    loadFences: () => loadFences("fence_rescan"),
    persistOrder,
    launch,
  };
}
