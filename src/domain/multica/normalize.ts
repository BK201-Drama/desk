import { asArray, asNumber, asObject, asString } from "../shared/safe";

export type MulticaIssue = { st: string; title: string; who: string; id: string };
export type MulticaSnapshot = {
  app_url: string;
  inbox: number;
  doing: number;
  review: number;
  issues: MulticaIssue[];
  runtime_online: boolean;
  cached: boolean;
  error: string | null;
};

export function multicaIssueUrl(appUrl: string, id: string): string {
  if (!appUrl || !id) return "";
  return `${appUrl.replace(/\/$/, "")}/issues/${id}`;
}

export function normalizeMulticaSnapshot(raw: unknown): MulticaSnapshot {
  const o = asObject<Record<string, unknown>>(raw) ?? {};
  return {
    app_url: asString(o.app_url),
    inbox: asNumber(o.inbox),
    doing: asNumber(o.doing),
    review: asNumber(o.review),
    issues: asArray<unknown>(o.issues).map((i) => {
      const row = asObject<Record<string, unknown>>(i) ?? {};
      return {
        st: asString(row.st),
        title: asString(row.title),
        who: asString(row.who),
        id: asString(row.id),
      };
    }),
    runtime_online: Boolean(o.runtime_online),
    cached: Boolean(o.cached),
    error: o.error == null ? null : asString(o.error),
  };
}
