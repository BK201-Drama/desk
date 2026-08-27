export function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatSyncTime(at: number) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function setSyncStatus(
  el: HTMLElement | null,
  at: number,
  ok: boolean,
  cached: boolean,
  error?: string | null
) {
  if (!el) return;
  const t = formatSyncTime(at);
  if (!ok) {
    el.textContent = `失败 ${t}`;
    el.className = "sync-hint err";
    el.title = error ?? "";
    return;
  }
  el.textContent = cached ? `缓存 ${t}` : `同步 ${t}`;
  el.className = cached ? "sync-hint cached" : "sync-hint";
  el.title = cached && error ? error : "";
}

export function isTextField(
  el: Element | null
): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}
