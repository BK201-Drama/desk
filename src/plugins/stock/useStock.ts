import { useCallback, useEffect, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import {
  DEFAULT_CODES,
  normalizeQuotes,
  type StockQuote,
} from "./model";
import { onStockBoot, peekStockBoot } from "./boot";

const POLL_MS = 15_000;

export function useStockQuotes(ctx: HostContext) {
  const [quotes, setQuotes] = useState<StockQuote[]>(() => peekStockBoot() ?? []);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const raw = await ctx.invoke("stock_quotes", {
        codes: [...DEFAULT_CODES],
      });
      setQuotes(normalizeQuotes(raw));
      setError("");
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
    }
  }, [ctx]);

  useEffect(() => {
    const unsub = onStockBoot(() => {
      const boot = peekStockBoot();
      if (boot?.length) setQuotes((prev) => (prev.length ? prev : boot));
    });
    const boot = peekStockBoot();
    if (boot?.length) setQuotes((prev) => (prev.length ? prev : boot));

    const bootTimer = window.setTimeout(() => void refresh(), 1200);
    const iv = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      unsub();
      window.clearTimeout(bootTimer);
      window.clearInterval(iv);
    };
  }, [refresh]);

  return { quotes, error, updatedAt, refresh };
}
