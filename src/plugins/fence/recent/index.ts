/**
 * 「最近」模块的**唯一出口**。
 *
 * 形态还没定 —— 本目录之外只允许依赖 `useRecents()` 与 `<RecentRow/>` 两个名字。
 * 以后改形态（换布局、换成折叠、加分组……）只动本目录，
 * 不要再去改 useFences.ts / model.ts / FencePanel.tsx 的结构。
 *
 * 打开一看只有两个文件的理由就是这个：边界小到「不会顺手改到别处」。
 * 唯一的例外是 Rust 侧的 `recent::remap_ids()` —— 迁移时要改写磁盘上的 id，
 * 那件事必须在 Rust 里做。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HostContext } from "../../../host/types";
import { findItemById, type FenceGroup, type FenceItem } from "../model";

// 出口就这两个。`./recent` 目录的默认解析目标是 index.ts，
// 所以 RecentRow 必须在这里转出去，`import { useRecents, RecentRow } from "./recent"` 才成立。
export { RecentRow } from "./RecentRow";

const RECENT_MAX = 4;

/** 读 / 写「最近」列表，并把它解析成当前围栏里的真实条目。 */
export function useRecents(ctx: HostContext, fences: FenceGroup[]) {
  const [ids, setIds] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try {
      const raw = await ctx.invoke<unknown>("recent_list");
      setIds(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
    } catch {
      setIds([]);
    }
  }, [ctx]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const push = useCallback(
    (id: string) => {
      if (!id || id.startsWith("sys-")) return;
      void ctx
        .invoke<unknown>("recent_push", { id })
        .then((raw) =>
          setIds(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [])
        )
        .catch(() => {});
    },
    [ctx]
  );

  const items = useMemo(
    () =>
      ids
        .slice(0, RECENT_MAX)
        .map((id) => findItemById(fences, id))
        // sys- 不进最近；图标已被删掉的条目也在这里自然掉队
        .filter((x): x is FenceItem => x !== null && !x.id.startsWith("sys-")),
    [ids, fences]
  );

  return { items, push };
}
