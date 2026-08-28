import { describe, expect, it } from "vitest";
import { normalizeReminders } from "./normalize";

describe("normalizeReminders", () => {
  it("handles null", () => {
    expect(normalizeReminders(null)).toEqual([]);
  });
  it("keeps valid rows", () => {
    expect(
      normalizeReminders([{ id: "1", title: "a", rule: "once", rule_label: "一次性", done: false }])
    ).toHaveLength(1);
  });
});
