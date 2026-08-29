import { describe, expect, it } from "vitest";
import {
  changeTone,
  formatChangePct,
  formatPrice,
  normalizeQuotes,
} from "./model";

describe("normalizeQuotes", () => {
  it("maps snake_case fields", () => {
    const list = normalizeQuotes([
      { code: "600519", name: "贵州茅台", price: 1680.5, change_pct: 1.25, market: "sh" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].changePct).toBe(1.25);
    expect(list[0].name).toBe("贵州茅台");
  });

  it("skips bad rows", () => {
    expect(normalizeQuotes([null, { name: "x" }, { code: "1" }])).toHaveLength(1);
  });
});

describe("changeTone / format", () => {
  it("red-up green-down", () => {
    expect(changeTone(1)).toBe("up");
    expect(changeTone(-1)).toBe("down");
    expect(changeTone(0)).toBe("flat");
  });

  it("formats", () => {
    expect(formatChangePct(1.2)).toBe("+1.20%");
    expect(formatChangePct(-0.5)).toBe("-0.50%");
    expect(formatPrice(3200.1)).toBe("3200.10");
  });
});
