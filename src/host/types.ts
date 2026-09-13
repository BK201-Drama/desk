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

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
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
  /** `cmd` 是 `src/generated/commands.ts` 里的联合类型，不是 `string` ——
      拼错命令名在这里就是 `tsc` 错误，而不是运行时的 `permission denied`。 */
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
