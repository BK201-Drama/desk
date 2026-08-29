import { describe, expect, it } from "vitest";
import { formatClockDate, formatClockTime } from "./time";

describe("lib/time clock format", () => {
  it("formats time as HH:MM", () => {
    const d = new Date(2026, 0, 15, 9, 5);
    expect(formatClockTime(d)).toBe("09:05");
  });

  it("formats date with weekday and month", () => {
    const d = new Date(2026, 0, 15); // Thursday
    expect(formatClockDate(d)).toContain("THU");
    expect(formatClockDate(d)).toContain("JAN");
    expect(formatClockDate(d)).toContain("15");
  });
});
