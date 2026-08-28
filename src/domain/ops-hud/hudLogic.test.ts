import { describe, expect, it } from "vitest";
import { ageLabel, rpcLabel } from "./hudLogic";

describe("ageLabel", () => {
  it("formats ages", () => {
    const now = 100_000;
    expect(ageLabel(undefined, now)).toBe("—");
    expect(ageLabel(now - 30_000, now)).toBe("30s");
    expect(ageLabel(now - 120_000, now)).toBe("2m");
    expect(ageLabel(now - 7200_000, now)).toBe("2h");
  });
});

describe("rpcLabel", () => {
  it("maps states", () => {
    expect(rpcLabel(null)).toBe("·");
    expect(rpcLabel(true)).toBe("ok");
    expect(rpcLabel(false)).toBe("err");
  });
});
