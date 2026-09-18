import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  bootTheme,
  getTheme,
  isDeskTheme,
  readStoredTheme,
  setTheme,
  toggleTheme,
} from "./theme";

function installDom() {
  const store = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};
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
    },
  });
}

describe("theme", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only day|night", () => {
    expect(isDeskTheme("day")).toBe(true);
    expect(isDeskTheme("night")).toBe(true);
    expect(isDeskTheme("purple")).toBe(false);
  });

  it("defaults to day", () => {
    expect(readStoredTheme()).toBe("day");
    expect(getTheme()).toBe("day");
  });

  it("setTheme writes DOM + storage", () => {
    setTheme("night");
    expect(document.documentElement.dataset.deskTheme).toBe("night");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("night");
    expect(getTheme()).toBe("night");
  });

  it("day clears data attribute", () => {
    setTheme("night");
    setTheme("day");
    expect(document.documentElement.dataset.deskTheme).toBeUndefined();
    expect(getTheme()).toBe("day");
  });

  it("toggleTheme flips", () => {
    expect(toggleTheme()).toBe("night");
    expect(toggleTheme()).toBe("day");
  });

  it("bootTheme restores stored preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "night");
    expect(bootTheme()).toBe("night");
    expect(document.documentElement.dataset.deskTheme).toBe("night");
  });

  it("applyTheme alone does not persist", () => {
    applyTheme("night");
    expect(document.documentElement.dataset.deskTheme).toBe("night");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});
