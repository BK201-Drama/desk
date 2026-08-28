export function ageLabel(at: number | undefined, now = Date.now()): string {
  if (!at) return "—";
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

export function rpcLabel(lastOk: boolean | null): string {
  if (lastOk == null) return "·";
  return lastOk ? "ok" : "err";
}
