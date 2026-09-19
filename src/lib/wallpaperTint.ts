/** 壁纸着色：像夜间模式一样是外观开关；开启后采样墙纸主色叠在玻璃上 */

import { invoke } from "@tauri-apps/api/core";

export type TintRgb = { r: number; g: number; b: number };

export const TINT_STORAGE_KEY = "desk.wallpaperTint";

type Sample = {
  ok: boolean;
  path: string;
  r: number;
  g: number;
  b: number;
  hint: string;
};

export function applyTint(rgb: TintRgb): void {
  const root = document.documentElement;
  root.style.setProperty("--desk-tint-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  root.dataset.deskTint = "on";
}

export function clearTint(): void {
  const root = document.documentElement;
  root.style.removeProperty("--desk-tint-rgb");
  delete root.dataset.deskTint;
}

export function isTintEnabled(): boolean {
  try {
    return localStorage.getItem(TINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistTintEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(TINT_STORAGE_KEY, "1");
    else localStorage.removeItem(TINT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** 采样并上色；失败则清掉 wash，返回是否成功。 */
export async function refreshWallpaperTint(): Promise<boolean> {
  try {
    const s = await invoke<Sample>("wallpaper_sample");
    if (s.ok) {
      applyTint({ r: s.r, g: s.g, b: s.b });
      return true;
    }
    clearTint();
    return false;
  } catch {
    clearTint();
    return false;
  }
}

/** 开关：开 → 采样上色；关 → 清掉。返回新状态。 */
export async function toggleWallpaperTint(): Promise<boolean> {
  const next = !isTintEnabled();
  persistTintEnabled(next);
  if (next) await refreshWallpaperTint();
  else clearTint();
  return next;
}

/** 启动：若曾开启则重新采样（壁纸可能已换）。 */
export async function bootWallpaperTint(): Promise<void> {
  if (!isTintEnabled()) {
    clearTint();
    return;
  }
  await refreshWallpaperTint();
}
