import { asNumber, asObject, asString } from "../shared/safe";

export type StockQuote = {
  code: string;
  name: string;
  price: number;
  changePct: number;
  market: string;
};

export const DEFAULT_CODES = [
  "1.518880", // 黄金ETF（华安黄金）
  "0.000066", // 中国长城
  "1.605378", // 野马电池
] as const;

export function normalizeQuote(raw: unknown): StockQuote | null {
  const o = asObject<Record<string, unknown>>(raw);
  if (!o) return null;
  const code = asString(o.code);
  if (!code) return null;
  return {
    code,
    name: asString(o.name) || code,
    price: asNumber(o.price),
    changePct: asNumber(o.change_pct ?? o.changePct),
    market: asString(o.market, "sh"),
  };
}

export function normalizeQuotes(raw: unknown): StockQuote[] {
  if (!Array.isArray(raw)) return [];
  const out: StockQuote[] = [];
  for (const row of raw) {
    const q = normalizeQuote(row);
    if (q) out.push(q);
  }
  return out;
}

/** A 股习惯：红涨绿跌 */
export function changeTone(changePct: number): "up" | "down" | "flat" {
  if (changePct > 0.005) return "up";
  if (changePct < -0.005) return "down";
  return "flat";
}

export function formatPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 100) return n.toFixed(2);
  return n.toFixed(2);
}

export function formatChangePct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
