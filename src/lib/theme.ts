/** desk 外观主题：日间（现有奶白玻璃）/ 夜间（暗玻璃） */

export type DeskTheme = "day" | "night";

export const THEME_STORAGE_KEY = "desk.theme";

export function isDeskTheme(value: unknown): value is DeskTheme {
  return value === "day" || value === "night";
}

export function readStoredTheme(): DeskTheme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isDeskTheme(raw)) return raw;
  } catch {
    /* private mode / non-browser */
  }
  return "day";
}

export function applyTheme(theme: DeskTheme): void {
  const root = document.documentElement;
  if (theme === "day") {
    delete root.dataset.deskTheme;
  } else {
    root.dataset.deskTheme = "night";
  }
}

export function persistTheme(theme: DeskTheme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function setTheme(theme: DeskTheme): DeskTheme {
  applyTheme(theme);
  persistTheme(theme);
  return theme;
}

export function getTheme(): DeskTheme {
  const attr = document.documentElement.dataset.deskTheme;
  return attr === "night" ? "night" : "day";
}

export function toggleTheme(): DeskTheme {
  return setTheme(getTheme() === "night" ? "day" : "night");
}

/** 启动时调用：读本地偏好并落到 DOM（须在首屏 paint 前） */
export function bootTheme(): DeskTheme {
  return setTheme(readStoredTheme());
}
