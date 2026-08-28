import { useCallback, useEffect, useState } from "react";
import type { HostContext } from "../../host/types";
import { normalizeReminders, type Reminder } from "../../domain/remind";

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
    void refresh();
  }, [refresh]);

  return { items, refresh, applyList, setItems };
}
