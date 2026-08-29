import { describe, expect, it } from "vitest";
import { formatUsedPct, normalizeUsage, toneFor } from "./model";

describe("normalizeUsage", () => {
  it("maps snake_case buckets", () => {
    const u = normalizeUsage({
      ok: true,
      remaining_pct: 26.3,
      used_pct: 73.7,
      auto_pct_used: 82,
      api_pct_used: 0,
      included_limit_usd: 20,
      included_used_usd: 20,
      included_remaining_usd: 0,
      total_spend_usd: 100,
      message: "x",
      auto_message: "auto",
      api_message: "api",
      hit_limit: true,
      hint: "",
    });
    expect(u.autoPctUsed).toBe(82);
    expect(u.apiPctUsed).toBe(0);
    expect(toneFor(u)).toBe("crit");
  });
});

describe("formatUsedPct", () => {
  it("matches Cursor wording", () => {
    expect(formatUsedPct(82.4)).toBe("82% used");
  });
});
