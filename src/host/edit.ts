type EditListener = (editing: boolean) => void;

let editing = false;
const listeners = new Set<EditListener>();

export function isEditing(): boolean {
  return editing;
}

export function setEditing(on: boolean): void {
  if (editing === on) return;
  editing = on;
  const board = document.getElementById("board");
  board?.classList.toggle("editing", on);
  for (const cb of [...listeners]) {
    try {
      cb(on);
    } catch (e) {
      console.error("onEditChange", e);
    }
  }
}

export function onEditChange(cb: EditListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function toggleEditing(): void {
  setEditing(!editing);
}
