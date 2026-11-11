import { useCallback, useEffect, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import { acceptRefresh, afterRefreshAttempt, emptyUsage, normalizeUsage, type CursorUsage, type RefreshSlot } from "./model";
import { onCursorBoot, peekCursorBoot } from "./boot";

const POLL_MS = 5 * 60 * 1000;

export function useCursorUsage(ctx: HostContext) {
  const [usage, setUsage] = useState<CursorUsage>(
    () => peekCursorBoot() ?? emptyUsage()
  );
  const slot = useRef<RefreshSlot>({ busy: false, pending: false });

  const refresh = useCallback(async () => {
    const accepted = acceptRefresh(slot.current);
    slot.current = accepted;
    if (accepted.pending) return;
    let again = true;
    while (again) {
      try {
        const raw = await ctx.invoke("cursor_usage");
        setUsage(normalizeUsage(raw));
      } catch (e) {
        setUsage(emptyUsage(String(e)));
      }
      const settled = afterRefreshAttempt(slot.current);
      slot.current = settled.slot;
      again = settled.again;
    }
  }, [ctx]);

  useEffect(() => {
    const unsub = onCursorBoot(() => {
      const boot = peekCursorBoot();
      if (boot?.ok) setUsage((prev) => (prev.ok ? prev : boot));
    });
    const boot = peekCursorBoot();
    if (boot?.ok) setUsage((prev) => (prev.ok ? prev : boot));

    const t = window.setTimeout(() => void refresh(), 1200);
    const iv = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      unsub();
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, [refresh]);

  return { usage, refresh };
}
