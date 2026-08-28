import { describe, expect, it } from "vitest";
import { asArray, asNumber, asObject, asString } from "./safe";

describe("asArray", () => {
  it("returns arrays as-is", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
  });
  it("returns empty for null/undefined/non-array", () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray({})).toEqual([]);
  });
});

describe("asObject", () => {
  it("returns plain objects", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
  });
  it("rejects null and arrays", () => {
    expect(asObject(null)).toBeNull();
    expect(asObject([])).toBeNull();
  });
});

describe("asString / asNumber", () => {
  it("falls back", () => {
    expect(asString(null, "x")).toBe("x");
    expect(asNumber("1", 7)).toBe(7);
    expect(asNumber(3)).toBe(3);
  });
});
