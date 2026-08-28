import { describe, expect, it } from "vitest";
import { formatClockDate, formatClockTime } from "./format";

describe("clock format", () => {
  it("formats time and date", () => {
    const d = new Date(2026, 7, 28, 15, 5, 0); // Aug 28 2026 Fri
    expect(formatClockTime(d)).toBe("15:05");
    expect(formatClockDate(d)).toBe("FRI · AUG 28");
  });
});
