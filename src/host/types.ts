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
  | "qqmusic.launch";

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
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
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

export type PluginModule = {
  mount: (el: HTMLElement, ctx: HostContext) => void | Promise<void>;
  unmount?: () => void | Promise<void>;
  onEditChange?: (editing: boolean) => void;
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

export type PluginsConfig = {
  active_preset: string;
  disabled: string[];
  custom_disabled?: string[] | null;
  /** 插件显示顺序；空则用各 manifest.order */
  order?: string[];
  custom_order?: string[] | null;
};

export type PresetInfo = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
};
