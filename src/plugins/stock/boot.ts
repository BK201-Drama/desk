import { invoke } from "@tauri-apps/api/core";
import { normalizeQuotes, type StockQuote } from "./model";

let bootQuotes: StockQuote[] | null = null;
const listeners = new Set<() => void>();

export function peekStockBoot(): StockQuote[] | null {
  return bootQuotes;
}

export function onStockBoot(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (e) {
      console.warn("onStockBoot", e);
    }
  }
}

export async function preloadStockBoot(): Promise<void> {
  try {
    const raw = await invoke("stock_cached");
    if (raw == null) {
      bootQuotes = null;
      notify();
      return;
    }
    const next = normalizeQuotes(raw);
    bootQuotes = next.length ? next : null;
    notify();
  } catch (e) {
    console.warn("preloadStockBoot", e);
    bootQuotes = null;
    notify();
  }
}
