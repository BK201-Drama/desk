import type { HostCommand } from "../../host/types";
import { EXTENDED_PLUGINS, MAIN_PLUGINS, PLUGIN_LABEL } from "./constants";

export type NavItem =
  | { kind: "cmd"; group: string; cmd: HostCommand }
  | { kind: "plugin"; group: "插件"; id: string; title: string; on: boolean };

export type ListRow =
  | { kind: "head"; label: string }
  | { kind: "item"; item: NavItem; index: number };

export function collectCommands(
  searching: boolean,
  extras: HostCommand[],
  allCommands: HostCommand[]
): HostCommand[] {
  const cmds = allCommands.filter((c) => c.id !== "cmdk:open" && c.id !== "open");
  const merged: HostCommand[] = [...extras, ...(searching ? cmds : [])];

  const seen = new Set<string>();
  const out: HostCommand[] = [];
  for (const c of merged) {
    if (seen.has(c.id)) continue;
    if (c.id.startsWith("host:enable:") || c.id.startsWith("host:disable:")) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

export function collectNav(
  filter: string,
  disabledIds: Set<string>,
  commands: HostCommand[]
): NavItem[] {
  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;
  const items: NavItem[] = [];

  for (const cmd of commands) {
    if (
      searching &&
      !cmd.title.toLowerCase().includes(q) &&
      !cmd.id.toLowerCase().includes(q) &&
      !(cmd.group ?? "").toLowerCase().includes(q) &&
      !(cmd.hint ?? "").toLowerCase().includes(q)
    ) {
      continue;
    }
    items.push({ kind: "cmd", group: cmd.group || "其他", cmd });
  }

  const pluginIds = searching
    ? Object.keys(PLUGIN_LABEL)
    : [...MAIN_PLUGINS, ...EXTENDED_PLUGINS.filter((id) => !disabledIds.has(id))];

  for (const id of pluginIds) {
    const title = PLUGIN_LABEL[id];
    if (!title) continue;
    if (
      searching &&
      !title.toLowerCase().includes(q) &&
      !id.toLowerCase().includes(q) &&
      !"插件".includes(q)
    ) {
      continue;
    }
    items.push({
      kind: "plugin",
      group: "插件",
      id,
      title,
      on: !disabledIds.has(id),
    });
  }

  return items;
}

export function buildRows(items: NavItem[]): ListRow[] {
  const rows: ListRow[] = [];
  let lastGroup = "";
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      rows.push({ kind: "head", label: item.group });
      lastGroup = item.group;
    }
    rows.push({ kind: "item", item, index });
  });
  return rows;
}

export function clampSelected(selected: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(selected, 0), itemCount - 1);
}
