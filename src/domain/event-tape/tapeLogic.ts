import { pad } from "../../host/util";

export type TapeLine = {
  at: number;
  type: string;
  source?: string;
  text: string;
};

export const TAPE_MAX = 60;

export function fmtTapeTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function isTapeNoise(type: string, detail: unknown): boolean {
  if (type.startsWith("host:command-")) return true;
  if (type === "invoke:ok" || type === "invoke:err") {
    const cmd = (detail as { cmd?: string } | null)?.cmd;
    if (cmd === "set_cursor" || cmd === "set_keyboard_input") return true;
  }
  return false;
}

export function summarizeTape(type: string, detail: unknown): string {
  if (!detail || typeof detail !== "object") return type;
  const d = detail as Record<string, unknown>;
  if (type === "invoke:ok" || type === "invoke:err") {
    return `${d.cmd ?? "?"} ${d.ms ?? "?"}ms`;
  }
  if (type === "fence:launch") return String(d.path ?? d.id ?? "");
  if (type === "plugin:mounted" || type === "plugin:unmounted") return String(d.id ?? "");
  if (type === "open:url") return String(d.url ?? "").slice(0, 40);
  if (type === "github:sync" || type === "multica:sync") {
    return d.ok ? `ok${d.cached ? " cache" : ""}` : "fail";
  }
  try {
    return JSON.stringify(detail).slice(0, 48);
  } catch {
    return type;
  }
}

export function appendTapeLine(lines: TapeLine[], next: TapeLine, max = TAPE_MAX): TapeLine[] {
  const out = [...lines, next];
  return out.length > max ? out.slice(-max) : out;
}

export function tapeHeadLabel(collapsed: boolean, lines: TapeLine[]): string {
  const last = lines[lines.length - 1];
  if (collapsed) {
    return `tape · ${lines.length}${last ? ` · ${last.type}` : ""}`;
  }
  return `event-tape · ${lines.length}`;
}
