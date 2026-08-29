import { asNumber, asObject, asString } from "../../lib/safe";

export type CursorUsage = {
  ok: boolean;
  remainingPct: number;
  usedPct: number;
  autoPctUsed: number;
  apiPctUsed: number;
  includedLimitUsd: number;
  includedUsedUsd: number;
  includedRemainingUsd: number;
  totalSpendUsd: number;
  message: string;
  autoMessage: string;
  apiMessage: string;
  billingCycleEndMs: number | null;
  hitLimit: boolean;
  hint: string;
};

export function emptyUsage(hint = ""): CursorUsage {
  return {
    ok: false,
    remainingPct: 0,
    usedPct: 0,
    autoPctUsed: 0,
    apiPctUsed: 0,
    includedLimitUsd: 0,
    includedUsedUsd: 0,
    includedRemainingUsd: 0,
    totalSpendUsd: 0,
    message: "",
    autoMessage: "",
    apiMessage: "",
    billingCycleEndMs: null,
    hitLimit: false,
    hint,
  };
}

export function normalizeUsage(raw: unknown): CursorUsage {
  const o = asObject<Record<string, unknown>>(raw);
  if (!o) return emptyUsage();
  return {
    ok: Boolean(o.ok),
    remainingPct: asNumber(o.remaining_pct ?? o.remainingPct),
    usedPct: asNumber(o.used_pct ?? o.usedPct),
    autoPctUsed: asNumber(o.auto_pct_used ?? o.autoPctUsed),
    apiPctUsed: asNumber(o.api_pct_used ?? o.apiPctUsed),
    includedLimitUsd: asNumber(o.included_limit_usd ?? o.includedLimitUsd),
    includedUsedUsd: asNumber(o.included_used_usd ?? o.includedUsedUsd),
    includedRemainingUsd: asNumber(o.included_remaining_usd ?? o.includedRemainingUsd),
    totalSpendUsd: asNumber(o.total_spend_usd ?? o.totalSpendUsd),
    message: asString(o.message),
    autoMessage: asString(o.auto_message ?? o.autoMessage),
    apiMessage: asString(o.api_message ?? o.apiMessage),
    billingCycleEndMs:
      o.billing_cycle_end_ms == null && o.billingCycleEndMs == null
        ? null
        : asNumber(o.billing_cycle_end_ms ?? o.billingCycleEndMs),
    hitLimit: Boolean(o.hit_limit ?? o.hitLimit),
    hint: asString(o.hint),
  };
}

export function toneFor(u: CursorUsage): "ok" | "warn" | "crit" | "off" {
  if (!u.ok) return "off";
  const used = Math.max(u.usedPct, u.autoPctUsed);
  if (u.hitLimit || used >= 95) return "crit";
  if (used >= 80) return "warn";
  return "ok";
}

export function formatUsedPct(n: number): string {
  if (!Number.isFinite(n)) return "—% used";
  return `${Math.round(n)}% used`;
}

export function barWidth(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
