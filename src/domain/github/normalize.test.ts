import { describe, expect, it } from "vitest";
import { normalizeGithubSnapshot } from "./normalize";

describe("normalizeGithubSnapshot", () => {
  it("null-safe empty snapshot", () => {
    const s = normalizeGithubSnapshot(null);
    expect(s.login).toBe("");
    expect(s.weeks).toEqual([]);
    expect(s.pins).toEqual([]);
  });
  it("keeps weeks", () => {
    const s = normalizeGithubSnapshot({ login: "a", weeks: [[1, 0]] });
    expect(s.weeks[0][0]).toBe(1);
  });
});
