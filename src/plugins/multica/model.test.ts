import { describe, expect, it } from "vitest";
import { multicaIssueUrl, normalizeMulticaSnapshot } from "./model";

describe("normalizeMulticaSnapshot", () => {
  it("null-safe", () => {
    const s = normalizeMulticaSnapshot(null);
    expect(s.issues).toEqual([]);
    expect(s.app_url).toBe("");
  });
});

describe("multicaIssueUrl", () => {
  it("joins", () => {
    expect(multicaIssueUrl("http://x/", "1")).toBe("http://x/issues/1");
  });
});
