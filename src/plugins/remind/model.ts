import { asArray, asObject, asString, asNumber } from "../../lib/safe";

export type Reminder = {
  id: string;
  title: string;
  rule: string;
  rule_label: string;
  done: boolean;
  created_at: number;
};

export function normalizeReminders(raw: unknown): Reminder[] {
  return asArray<unknown>(raw)
    .map((item) => {
      const o = asObject<Record<string, unknown>>(item);
      if (!o) return null;
      const id = asString(o.id);
      if (!id) return null;
      return {
        id,
        title: asString(o.title, "待办"),
        rule: asString(o.rule, "once"),
        rule_label: asString(o.rule_label, o.rule as string) || "once",
        done: Boolean(o.done),
        created_at: asNumber(o.created_at, 0),
      };
    })
    .filter((x): x is Reminder => x != null);
}
