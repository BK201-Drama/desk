import type { HostContext, PluginModule } from "../../host/types";
import { escapeHtml, pad } from "../../host/util";
import "./panel.css";

type TapeLine = {
  at: number;
  type: string;
  source?: string;
  text: string;
};

const MAX = 60;

let lines: TapeLine[] = [];
let root: HTMLElement | null = null;
let unsub: (() => void) | null = null;
/** collapsed by default — never cover fences on boot */
let collapsed = true;

function fmtTime(at: number) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isNoise(type: string, detail: unknown): boolean {
  if (type.startsWith("host:command-")) return true;
  if (type === "invoke:ok" || type === "invoke:err") {
    const cmd = (detail as { cmd?: string } | null)?.cmd;
    // cursor chatter floods the tape
    if (cmd === "set_cursor" || cmd === "set_keyboard_input") return true;
  }
  return false;
}

function summarize(type: string, detail: unknown): string {
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

function render() {
  if (!root) return;
  const wrap = root.querySelector(".event-tape");
  const body = root.querySelector(".event-tape-body");
  const head = root.querySelector(".event-tape-head span");
  const last = lines[lines.length - 1];
  if (head) {
    head.textContent = collapsed
      ? `tape · ${lines.length}${last ? ` · ${last.type}` : ""}`
      : `event-tape · ${lines.length}`;
  }
  wrap?.classList.toggle("collapsed", collapsed);
  if (!body) return;
  if (collapsed) {
    body.innerHTML = "";
    return;
  }
  const slice = lines.slice(-24).reverse();
  body.innerHTML = slice
    .map(
      (l) => `<div class="event-tape-line">
      <span class="t">${fmtTime(l.at)}</span>
      <span class="ty">${escapeHtml(l.type)}</span>
      <span class="tx">${escapeHtml(l.text)}</span>
    </div>`
    )
    .join("");
}

const panel: PluginModule = {
  async mount(el, ctx: HostContext) {
    root = el;
    collapsed = true;
    el.innerHTML = `
      <div class="event-tape collapsed">
        <button type="button" class="event-tape-head" title="展开/收起事件流">
          <span>tape · 0</span>
          <kbd>▸</kbd>
        </button>
        <div class="event-tape-body"></div>
      </div>`;

    el.querySelector(".event-tape-head")?.addEventListener("click", () => {
      collapsed = !collapsed;
      const kbd = el.querySelector(".event-tape-head kbd");
      if (kbd) kbd.textContent = collapsed ? "▸" : "▾";
      render();
    });

    ctx.registerCommand({
      id: "toggle",
      title: "展开/收起 Event Tape",
      group: "Desk",
      run: () => {
        collapsed = !collapsed;
        render();
      },
    });

    unsub = ctx.on("*", (ev) => {
      if (isNoise(ev.type, ev.detail)) return;
      lines.push({
        at: ev.at,
        type: ev.type,
        source: ev.source,
        text: summarize(ev.type, ev.detail),
      });
      if (lines.length > MAX) lines = lines.slice(-MAX);
      render();
    });
    render();
  },
  unmount() {
    unsub?.();
    unsub = null;
    root = null;
    lines = [];
    collapsed = true;
  },
};

export default panel;
