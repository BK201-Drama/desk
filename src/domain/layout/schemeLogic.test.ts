import { describe, expect, it } from "vitest";
import {
  canCreateScheme,
  hasSchemeDraft,
  idsFromSnapshot,
  isBuiltinPreset,
  MAX_SCHEMES,
} from "./schemeLogic";
import type { PluginsConfig } from "../../host/types";

describe("schemeLogic", () => {
  it("idsFromSnapshot respects order and disabled", () => {
    const ids = idsFromSnapshot(["qq-music"], ["github", "multica"]);
    expect(ids[0]).toBe("github");
    expect(ids[1]).toBe("multica");
    expect(ids).not.toContain("qq-music");
  });

  it("hasSchemeDraft when live state differs from active scheme", () => {
    const cfg: PluginsConfig = {
      active_preset: "scheme",
      active_scheme_id: "s1",
      disabled: ["qq-music"],
      order: ["github"],
      schemes: [{ id: "s1", name: "A", disabled: [], order: ["github"] }],
    };
    expect(hasSchemeDraft(cfg)).toBe(true);
  });

  it("canCreateScheme up to MAX_SCHEMES", () => {
    const cfg: PluginsConfig = {
      active_preset: "coder",
      disabled: [],
      schemes: Array.from({ length: MAX_SCHEMES }, (_, i) => ({
        id: `s${i}`,
        name: `方案 ${i}`,
        disabled: [],
        order: [],
      })),
    };
    expect(canCreateScheme(cfg)).toBe(false);
  });

  it("isBuiltinPreset", () => {
    expect(isBuiltinPreset("coder")).toBe(true);
    expect(isBuiltinPreset("scheme")).toBe(false);
  });
});
