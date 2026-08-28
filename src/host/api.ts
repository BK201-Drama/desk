import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { emit, on } from "./events";
import { isEditing, onEditChange } from "./edit";
import type {
  HostCommand,
  HostContext,
  PluginManifest,
  PluginPermission,
} from "./types";

/** permission → allowed Tauri command names */
const PERM_COMMANDS: Record<PluginPermission, string[]> = {
  "github.read": ["github_snapshot"],
  "github.write": ["github_set_token"],
  "multica.read": ["multica_snapshot", "multica_app_url"],
  "remind.read": ["remind_list"],
  "remind.write": ["remind_add", "remind_toggle", "remind_remove"],
  "fence.read": ["fence_list", "fence_status"],
  "fence.write": ["fence_takeover", "fence_restore", "fence_save_order"],
  "fence.launch": ["fence_launch"],
  "recent.read": ["recent_list"],
  "recent.write": ["recent_push"],
  "host.autostart": ["autostart_get", "autostart_set"],
  "host.window": ["set_cursor", "set_keyboard_input", "set_click_through"],
  "host.plugins": [
    "plugin_list_user",
    "plugin_get_config",
    "plugin_set_disabled",
    "plugin_set_order",
    "plugin_list_presets",
    "plugin_apply_preset",
    "plugin_save_custom",
    "plugin_storage_get",
    "plugin_storage_set",
  ],
  "host.log": [],
  "host.open": [],
  "qqmusic.launch": [
    "qqmusic_status",
    "qqmusic_now_playing",
    "qqmusic_ensure_running",
    "qqmusic_launch",
    "qqmusic_toggle",
    "qqmusic_next",
    "qqmusic_prev"
  ],
};

const commandOwners = new Map<string, HostCommand>();
const commandsByPlugin = new Map<string, Set<string>>();

export function registerCommand(cmd: HostCommand, pluginId?: string): () => void {
  commandOwners.set(cmd.id, cmd);
  if (pluginId) {
    let set = commandsByPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      commandsByPlugin.set(pluginId, set);
    }
    set.add(cmd.id);
  }
  emit("host:command-register", { id: cmd.id, title: cmd.title }, "host");
  return () => {
    if (commandOwners.get(cmd.id) === cmd) {
      commandOwners.delete(cmd.id);
      emit("host:command-unregister", { id: cmd.id }, "host");
    }
    if (pluginId) {
      commandsByPlugin.get(pluginId)?.delete(cmd.id);
    }
  };
}

export function clearPluginCommands(pluginId: string): void {
  const set = commandsByPlugin.get(pluginId);
  if (!set) return;
  for (const id of set) {
    commandOwners.delete(id);
  }
  commandsByPlugin.delete(pluginId);
}

export function listCommands(): HostCommand[] {
  return [...commandOwners.values()];
}

function allowedCommands(perms: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const p of perms) {
    const cmds = PERM_COMMANDS[p as PluginPermission];
    if (cmds) for (const c of cmds) out.add(c);
  }
  return out;
}

function makeStorage(pluginId: string) {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return tauriInvoke<T | null>("plugin_storage_get", {
        plugin_id: pluginId,
        key,
      });
    },
    async set(key: string, value: unknown): Promise<void> {
      await tauriInvoke("plugin_storage_set", {
        plugin_id: pluginId,
        key,
        value,
      });
    },
  };
}

export function createHostContext(manifest: PluginManifest): HostContext {
  const permissions = new Set(manifest.permissions);
  const allowed = allowedCommands(permissions);
  const pluginId = manifest.id;

  return {
    pluginId,
    permissions,
    async invoke<T = unknown>(cmd: string, args?: Record<string, unknown>) {
      if (!allowed.has(cmd)) {
        emit(
          "invoke:denied",
          { cmd, pluginId },
          pluginId
        );
        throw new Error(`permission denied: ${cmd} (plugin ${pluginId})`);
      }
      const started = Date.now();
      try {
        const result = await tauriInvoke<T>(cmd, args);
        emit(
          "invoke:ok",
          { cmd, ms: Date.now() - started, args: args ? Object.keys(args) : [] },
          pluginId
        );
        return result;
      } catch (e) {
        emit(
          "invoke:err",
          { cmd, ms: Date.now() - started, error: String(e) },
          pluginId
        );
        throw e;
      }
    },
    async openUrl(url: string) {
      if (!permissions.has("host.open")) {
        throw new Error(`permission denied: host.open (plugin ${pluginId})`);
      }
      try {
        await tauriOpenUrl(url);
        emit("open:url", { url }, pluginId);
      } catch {
        window.open(url, "_blank");
        emit("open:url", { url, fallback: true }, pluginId);
      }
    },
    convertFileSrc,
    editing: isEditing,
    onEditChange,
    emit: (type, detail) => emit(type, detail, pluginId),
    on,
    storage: makeStorage(pluginId),
    registerCommand: (cmd) => {
      const wrapped: HostCommand = {
        ...cmd,
        id: cmd.id.includes(":") ? cmd.id : `${pluginId}:${cmd.id}`,
        run: async () => {
          emit("command:run", { id: cmd.id }, pluginId);
          await cmd.run();
        },
      };
      const unsub = registerCommand(wrapped, pluginId);
      return unsub;
    },
    listCommands,
  };
}
