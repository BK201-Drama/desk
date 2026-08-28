import { asArray, asNumber, asObject, asString } from "../shared/safe";

export type ContribCell = { date: string; count: number; level: number };
export type GithubPin = {
  repo: string;
  desc: string;
  lang: string;
  lang_name: string;
  stars: string;
};
export type GithubLang = { name: string; pct: number; color: string };
export type GithubSnapshot = {
  login: string;
  name: string;
  bio: string;
  avatar_url: string;
  streak: number;
  year_total: number;
  weeks: number[][];
  contrib_cells: ContribCell[];
  pins: GithubPin[];
  langs: GithubLang[];
  cached: boolean;
  error: string | null;
};

export function formatContribTip(date: string, count: number): string {
  if (!date) return "";
  const [y, m, d] = date.split("-").map(Number);
  const local = new Date(y, (m || 1) - 1, d || 1);
  const label = local.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  if (!count) return `${label}：无贡献`;
  return `${label}：${count} 次贡献`;
}

export function normalizeGithubSnapshot(raw: unknown): GithubSnapshot {
  const o = asObject<Record<string, unknown>>(raw) ?? {};
  const weeksRaw = asArray<unknown>(o.weeks);
  const weeks = weeksRaw.map((w) =>
    asArray<unknown>(w).map((n) => asNumber(n, 0))
  );
  return {
    login: asString(o.login),
    name: asString(o.name),
    bio: asString(o.bio),
    avatar_url: asString(o.avatar_url),
    streak: asNumber(o.streak),
    year_total: asNumber(o.year_total),
    weeks,
    contrib_cells: asArray<unknown>(o.contrib_cells).map((c) => {
      const cell = asObject<Record<string, unknown>>(c) ?? {};
      return {
        date: asString(cell.date),
        count: asNumber(cell.count),
        level: asNumber(cell.level),
      };
    }),
    pins: asArray<unknown>(o.pins).map((p) => {
      const pin = asObject<Record<string, unknown>>(p) ?? {};
      return {
        repo: asString(pin.repo),
        desc: asString(pin.desc),
        lang: asString(pin.lang),
        lang_name: asString(pin.lang_name),
        stars: asString(pin.stars),
      };
    }),
    langs: asArray<unknown>(o.langs).map((l) => {
      const lang = asObject<Record<string, unknown>>(l) ?? {};
      return {
        name: asString(lang.name),
        pct: asNumber(lang.pct),
        color: asString(lang.color, "#ccc"),
      };
    }),
    cached: Boolean(o.cached),
    error: o.error == null ? null : asString(o.error),
  };
}
