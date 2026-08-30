import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import { normalizeReminders, type Reminder } from "./model";

export function useReminders(ctx: HostContext) {
  const [items, setItems] = useState<Reminder[]>([]);

  const refresh = useCallback(async () => {
    try {
      const raw = await ctx.invoke("remind_list");
      setItems(normalizeReminders(raw));
    } catch (e) {
      console.error("remind_list", e);
    }
  }, [ctx]);

  const applyList = useCallback((raw: unknown) => {
    setItems(normalizeReminders(raw));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(), 200);
    return () => window.clearTimeout(t);
  }, [refresh]);

  return { items, refresh, applyList, setItems };
}
