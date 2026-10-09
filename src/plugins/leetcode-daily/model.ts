import { asObject, asString } from "../../lib/safe";

export type LeetCodeDaily = {
  date: string;
  frontendId: string;
  titleCn: string;
  titleSlug: string;
  difficulty: string;
};

export function normalizeDaily(raw: unknown): LeetCodeDaily | null {
  const o = asObject<Record<string, unknown>>(raw);
  if (!o) return null;
  const titleSlug = asString(o.title_slug ?? o.titleSlug);
  if (!titleSlug) return null;
  const titleCn =
    asString(o.title_cn ?? o.titleCn) || asString(o.title) || titleSlug;
  return {
    date: asString(o.date),
    frontendId: asString(o.frontend_id ?? o.frontendId),
    titleCn,
    titleSlug,
    difficulty: asString(o.difficulty),
  };
}

export function problemUrl(titleSlug: string): string {
  return `https://leetcode.cn/problems/${titleSlug}/`;
}

export function difficultyLabel(raw: string): string {
  switch (raw.trim().toUpperCase()) {
    case "EASY":
      return "简单";
    case "MEDIUM":
      return "中等";
    case "HARD":
      return "困难";
    default:
      return raw.trim() ? raw : "—";
  }
}
