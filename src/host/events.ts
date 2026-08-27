import type { DeskEvent } from "./types";

type Listener = (ev: DeskEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const starListeners = new Set<Listener>();

export function emit(type: string, detail?: unknown, source?: string): DeskEvent {
  const ev: DeskEvent = { type, at: Date.now(), source, detail };
  const set = listeners.get(type);
  if (set) {
    for (const cb of [...set]) {
      try {
        cb(ev);
      } catch (e) {
        console.error("event listener", type, e);
      }
    }
  }
  for (const cb of [...starListeners]) {
    try {
      cb(ev);
    } catch (e) {
      console.error("event * listener", e);
    }
  }
  return ev;
}

export function on(type: string | "*", cb: Listener): () => void {
  if (type === "*") {
    starListeners.add(cb);
    return () => starListeners.delete(cb);
  }
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(cb);
  return () => set!.delete(cb);
}
