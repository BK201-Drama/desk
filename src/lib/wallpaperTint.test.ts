import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  TINT_STORAGE_KEY,
  applyTint,
  clearTint,
  isTintEnabled,
  persistTintEnabled,
} from "./wallpaperTint";

function installDom() {
  const props = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
  vi.stubGlobal("document", {
    documentElement: {
      dataset,
      style: {
        setProperty: (k: string, v: string) => {
          props.set(k, v);
        },
        removeProperty: (k: string) => {
          props.delete(k);
        },
        getPropertyValue: (k: string) => props.get(k) ?? "",
      },
    },
  });
}

describe("wallpaperTint", () => {
  beforeEach(() => installDom());
  afterEach(() => vi.unstubAllGlobals());

  it("applyTint sets rgb var and data attr", () => {
    applyTint({ r: 10, g: 20, b: 30 });
    expect(document.documentElement.style.getPropertyValue("--desk-tint-rgb")).toBe(
      "10, 20, 30"
    );
    expect(document.documentElement.dataset.deskTint).toBe("on");
  });

  it("clearTint removes both", () => {
    applyTint({ r: 1, g: 2, b: 3 });
    clearTint();
    expect(document.documentElement.style.getPropertyValue("--desk-tint-rgb")).toBe("");
    expect(document.documentElement.dataset.deskTint).toBeUndefined();
  });

  it("persistTintEnabled mirrors localStorage", () => {
    expect(isTintEnabled()).toBe(false);
    persistTintEnabled(true);
    expect(localStorage.getItem(TINT_STORAGE_KEY)).toBe("1");
    expect(isTintEnabled()).toBe(true);
    persistTintEnabled(false);
    expect(isTintEnabled()).toBe(false);
  });
});
