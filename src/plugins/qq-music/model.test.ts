import { describe, expect, it } from "vitest";
import {
  displayTitle,
  normalizeNowPlaying,
  stabilizeStatus,
  trackKey,
} from "./model";

describe("normalizeNowPlaying", () => {
  it("null-safe", () => {
    expect(normalizeNowPlaying(null).status).toBe("stopped");
  });
});

describe("trackKey / stabilizeStatus", () => {
  it("keeps stable playing across unknown", () => {
    const prev = normalizeNowPlaying({
      active: true,
      title: "a",
      artist: "b",
      album: "c",
      status: "playing",
    });
    const next = { ...prev, status: "changing" };
    const r = stabilizeStatus(next, prev, "stopped");
    expect(r.status).toBe("playing");
    expect(trackKey(prev)).toBe(trackKey(next));
  });
});

describe("displayTitle", () => {
  it("inactive", () => {
    expect(displayTitle(normalizeNowPlaying({ active: false }))).toBe("未在播放");
  });
});
