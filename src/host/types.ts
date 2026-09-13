import type { CommandName } from "../generated/commands";

export type PluginSlot = "left" | "right" | "overlay";

export type PluginPermission =
  | "github.read"
  | "github.write"
  | "multica.read"
  | "remind.read"
  | "remind.write"
  | "fence.read"
  | "fence.write"
  | "fence.launch"
  | "recent.read"
  | "recent.write"
  | "host.autostart"
  | "host.window"
  | "host.plugins"
  | "host.log"
  | "host.open"
  | "qqmusic.launch"
  | "stock.read"
  | "cursor.read"
  | "sys-res.read";

/**
 * 没有 `name` / `version`：两者从插件宿主第一天起就**没有任何读取者**（面板标题走
 * `PLUGIN_LABEL` 或 id），2026-09-14 用户裁决删掉、需要时再加。旧 manifest 里若还留着
 * 这两个键不会报错（serde 与 `import.meta.glob` 都直接忽略多余字段）。
 */
export type PluginManifest = {
  id: string;
  slot: PluginSlot;
  entry: string;
  permissions: PluginPermission[];
  order?: number;
};

export type DeskEvent = {
  type: string;
  at: number;
  source?: string;
  detail?: unknown;
};

export type HostStorage = {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown) => Promise<void>;
};

export type HostContext = {
  pluginId: string;
  permissions: ReadonlySet<string>;
  /** `cmd` 是 `CommandName`（`src/generated/commands.ts`），不是 `string` —— 拼错命令名这里是 `tsc` 错误。 */
  invoke: <T = unknown>(cmd: CommandName, args?: Record<string, unknown>) => Promise<T>;
  openUrl: (url: string) => Promise<void>;
  convertFileSrc: (path: string) => string;
  editing: () => boolean;
  onEditChange: (cb: (editing: boolean) => void) => () => void;
  emit: (type: string, detail?: unknown) => void;
  on: (type: string | "*", cb: (ev: DeskEvent) => void) => () => void;
  storage: HostStorage;
  registerCommand: (cmd: HostCommand) => () => void;
  listCommands: () => HostCommand[];
};

export type HostCommand = {
  id: string;
  title: string;
  hint?: string;
  group?: string;
  run: () => void | Promise<void>;
};

import type { ComponentType } from "react";

export type PluginComponentProps = {
  ctx: HostContext;
};

export type PluginModule = {
  /** legacy vanilla 插件 */
  mount?: (el: HTMLElement, ctx: HostContext) => void | Promise<void>;
  unmount?: () => void | Promise<void>;
  onEditChange?: (editing: boolean) => void;
  /** React 插件（内置插件逐步迁移） */
  Component?: ComponentType<PluginComponentProps>;
};

export type BundledPlugin = {
  manifest: PluginManifest;
  load: () => Promise<PluginModule>;
};

export type UserPluginInfo = {
  id: string;
  dir: string;
  manifest_path: string;
  entry_path: string;
  css_path: string | null;
  manifest: PluginManifest;
};

export type LayoutScheme = {
  id: string;
  name: string;
  disabled: string[];
  order: string[];
};

export type PluginsConfig = {
  active_preset: string;
  active_scheme_id?: string | null;
  disabled: string[];
  order?: string[];
  schemes?: LayoutScheme[];
};

export type PresetInfo = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
};
