import { useSyncExternalStore } from "react";
import type { HostContext, PluginManifest, PluginModule } from "./types";

/** 供 Board 单树渲染的挂载快照（不再每插件 createRoot） */
export type MountEntry = {
  manifest: PluginManifest;
  source: "bundled" | "user";
  mod: PluginModule;
  ctx: HostContext;
  order: number;
  error?: string;
};

let entries: MountEntry[] = [];
const listeners = new Set<() => void>();

function emitChange() {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (e) {
      console.error("mount-store listener", e);
    }
  }
}

export function getMountEntries(): MountEntry[] {
  return entries;
}

export function setMountEntries(next: MountEntry[]): void {
  entries = next;
  emitChange();
}

export function subscribeMountEntries(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useMountEntries(): MountEntry[] {
  return useSyncExternalStore(subscribeMountEntries, getMountEntries, getMountEntries);
}
