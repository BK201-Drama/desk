import { invoke } from "@tauri-apps/api/core";
import { normalizeUsage, type CursorUsage } from "./model";

let bootUsage: CursorUsage | null = null;
const listeners = new Set<() => void>();

export function peekCursorBoot(): CursorUsage | null {
  return bootUsage;
}

export function onCursorBoot(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (e) {
      console.warn("onCursorBoot", e);
    }
  }
}

export async function preloadCursorBoot(): Promise<void> {
  try {
    const raw = await invoke("cursor_cached");
    if (raw == null) {
      bootUsage = null;
      notify();
      return;
    }
    const next = normalizeUsage(raw);
    bootUsage = next.ok ? next : null;
    notify();
  } catch (e) {
    console.warn("preloadCursorBoot", e);
    bootUsage = null;
    notify();
  }
}
